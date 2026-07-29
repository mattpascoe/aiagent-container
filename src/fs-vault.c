/*
 * fs-vault.c — cross-image credential shield (LD_PRELOAD)
 *
 * Intercepts the open/fopen family for every dynamically-linked process in the
 * container and denies reads of known agent credential files unless the caller
 * is the agent that owns them.
 *
 * ---------------------------------------------------------------------------
 * THREAT MODEL — read this before trusting it
 * ---------------------------------------------------------------------------
 * This is a defense-in-depth speed bump, NOT a security boundary. It reliably
 * stops the realistic accident//casual-exfil case: an agent tool shelling out
 * to `cat`/`grep`/`python` to slurp a token. It does NOT stop a determined
 * attacker in the same uid. Known, accepted gaps:
 *
 *   1. Non-libc callers. LD_PRELOAD only binds dynamically-linked libc users.
 *      Static Go binaries or direct-syscall code bypass it entirely, and every
 *      image ships build-essential + python3-dev, so an agent can build one.
 *   2. Node-vs-Node is indistinguishable. All our agents are Node, so
 *      /proc/self/exe is /usr/local/bin/node for pi, claude, opencode AND for
 *      any `node evil.js`. IDENT_EXE rules therefore cannot separate the real
 *      agent from an arbitrary script it spawns. We accept this: the win is
 *      blocking shell utilities, not sandboxing Node from itself.
 *   3. argv is attacker-controlled. IDENT_ARGV rules exist only for agents
 *      with no stable exe path; they are trivially spoofed by adding the magic
 *      string to your own argv. Prefer IDENT_EXE wherever possible.
 *   4. Only the open family is hooked. rename/link/stat-based probing, and
 *      already-open inherited fds, are untouched.
 *
 * The robust fix for (2)/(3) is OS-level: run each agent as its own uid and
 * chmod 0600 the credential files to that uid, so the kernel enforces it and
 * this shim is merely belt-and-braces. Today everything runs as one uid that
 * OWNS its own secrets, so DAC alone provides nothing against same-uid reads.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <unistd.h>

/* ------------------------------------------------------------------------- */
/* Real symbol resolution (cached — dlsym on every open() is measurable)     */
/* ------------------------------------------------------------------------- */

static int   (*real_open)    (const char *, int, ...)      = NULL;
static int   (*real_open64)  (const char *, int, ...)      = NULL;
static int   (*real_openat)  (int, const char *, int, ...) = NULL;
static int   (*real_openat64)(int, const char *, int, ...) = NULL;
static FILE *(*real_fopen)   (const char *, const char *)  = NULL;
static FILE *(*real_fopen64) (const char *, const char *)  = NULL;

static void init_hooks(void) {
    if (real_open) return;
    real_openat   = dlsym(RTLD_NEXT, "openat");
    real_open64   = dlsym(RTLD_NEXT, "open64");
    real_openat64 = dlsym(RTLD_NEXT, "openat64");
    real_fopen    = dlsym(RTLD_NEXT, "fopen");
    real_fopen64  = dlsym(RTLD_NEXT, "fopen64");
    real_open     = dlsym(RTLD_NEXT, "open");  /* set last: acts as the guard */
}

/* ------------------------------------------------------------------------- */
/* Policy table                                                             */
/* ------------------------------------------------------------------------- */

/* How to establish caller identity for an allow rule. */
typedef enum {
    IDENT_EXE,   /* match against /proc/self/exe  — not argv-forgeable */
    IDENT_ARGV   /* match against /proc/self/cmdline — FORGEABLE, last resort */
} ident_kind;

typedef struct {
    const char *needle;      /* substring of the path being opened     */
    ident_kind  kind;
    const char *owner_a;     /* allowed identity (NULL = allow nobody) */
    const char *owner_b;     /* optional second allowed identity       */
    const char *label;
} vault_rule;

/*
 * Guarded paths, one row per credential store.
 *
 * NOTE on the Node entries: owner is the node binary, which (per gap #2)
 * admits any Node process. That is deliberate and documented — it still
 * denies cat/grep/tail/python/sh, which is the attack we actually see.
 * Tighten by giving each agent its own uid, not by adding argv rules.
 */
static const vault_rule rules[] = {
    /* pi — OpenRouter/Copilot tokens */
    { "/.pi/agent/auth.json",  IDENT_EXE,  "/usr/local/bin/node", NULL, "pi auth" },

    /* claude code — oauth creds + config (config holds tokens in some versions) */
    { "/.claude/.credentials.json", IDENT_EXE, "/usr/local/bin/node", NULL, "claude creds" },
    { "/.claude.json",              IDENT_EXE, "/usr/local/bin/node", NULL, "claude config" },

    /* opencode */
    { "/.local/share/opencode/auth.json", IDENT_EXE, "/usr/local/bin/node", NULL, "opencode auth" },

    /* hermes — installed as a real binary, so it gets a precise exe rule */
    { "/hermes-agent/auth.json", IDENT_EXE, "/usr/local/lib/hermes-agent", "/usr/local/bin/hermes", "hermes auth" },

    /* generic: bare auth.json anywhere else. Keep LAST — broad catch-all. */
    { "auth.json", IDENT_EXE, "/usr/local/bin/node", "/usr/local/bin/hermes", "generic auth" },
};

#define N_RULES (sizeof(rules) / sizeof(rules[0]))

/* ------------------------------------------------------------------------- */
/* Caller identity (resolved once per process, then cached)                  */
/* ------------------------------------------------------------------------- */

static char self_exe[512];
static char self_cmd[512];
static int  ident_ready = 0;

static void load_identity(void) {
    if (ident_ready) return;
    ident_ready = 1;  /* set first: a failed probe must not loop */

    ssize_t n = readlink("/proc/self/exe", self_exe, sizeof(self_exe) - 1);
    if (n > 0) self_exe[n] = '\0';

    if (real_open) {
        int fd = real_open("/proc/self/cmdline", O_RDONLY);
        if (fd >= 0) {
            ssize_t got = read(fd, self_cmd, sizeof(self_cmd) - 1);
            close(fd);
            if (got > 0) {
                for (ssize_t i = 0; i < got; i++)
                    if (self_cmd[i] == '\0') self_cmd[i] = ' ';
                self_cmd[got] = '\0';
            }
        }
    }
}

static int identity_matches(const vault_rule *r) {
    const char *hay = (r->kind == IDENT_EXE) ? self_exe : self_cmd;
    if (!hay[0]) return 0;                                  /* unknown → deny */
    if (r->owner_a && strstr(hay, r->owner_a)) return 1;
    if (r->owner_b && strstr(hay, r->owner_b)) return 1;
    return 0;
}

static int is_blocked(const char *pathname) {
    if (!pathname) return 0;

    init_hooks();
    if (!real_open) return 0;  /* failsafe: never break the container */

    for (size_t i = 0; i < N_RULES; i++) {
        if (!strstr(pathname, rules[i].needle)) continue;
        load_identity();
        return identity_matches(&rules[i]) ? 0 : 1;
    }
    return 0;
}

/* ------------------------------------------------------------------------- */
/* Interposed symbols                                                       */
/* ------------------------------------------------------------------------- */

#define OPEN_BODY(fnptr, ...)                     \
    do {                                          \
        if (is_blocked(pathname)) {                \
            errno = EACCES;                        \
            return -1;                             \
        }                                          \
        if (!fnptr) { errno = ENOSYS; return -1; } \
        if (flags & O_CREAT) {                     \
            va_list ap; mode_t mode;               \
            va_start(ap, flags);                   \
            mode = va_arg(ap, mode_t);             \
            va_end(ap);                            \
            return fnptr(__VA_ARGS__, flags, mode);\
        }                                          \
        return fnptr(__VA_ARGS__, flags);          \
    } while (0)

int open(const char *pathname, int flags, ...) {
    init_hooks();
    OPEN_BODY(real_open, pathname);
}

int open64(const char *pathname, int flags, ...) {
    init_hooks();
    OPEN_BODY(real_open64, pathname);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
    init_hooks();
    OPEN_BODY(real_openat, dirfd, pathname);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
    init_hooks();
    OPEN_BODY(real_openat64, dirfd, pathname);
}

FILE *fopen(const char *pathname, const char *mode) {
    init_hooks();
    if (is_blocked(pathname)) { errno = EACCES; return NULL; }
    if (!real_fopen) { errno = ENOSYS; return NULL; }
    return real_fopen(pathname, mode);
}

FILE *fopen64(const char *pathname, const char *mode) {
    init_hooks();
    if (is_blocked(pathname)) { errno = EACCES; return NULL; }
    if (!real_fopen64) { errno = ENOSYS; return NULL; }
    return real_fopen64(pathname, mode);
}
