# AI Harness

A hardened Docker environment for running AI coding agents with defense-in-depth security controls. The containers are read-only, run as a non-root user matching the host's UID/GID, and ship two complementary sandboxing layers to prevent agents from escaping their workspace or exfiltrating credentials.

The goal is to make a simple way to just spin up a reasonably locked down container to isolate blast radius. You mount up one or more directories to actually work within. The configuration is stored in your home directory and mounted in from the host side so that it is persistent. While you could use that config from the host side, it is recommended to only run from within the container.

Bottom line however, always treat the containers as a sandbox and do not trust them fully. They could still do weird things.

## Services

| Service | Agent | Image |
|---------|-------|-------|
| `pi` | [Pi Coding Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`@earendil-works/pi-coding-agent`) | `local/<user>-pi` |
| `claude` | [Claude Code](https://claude.ai/code) (`@anthropic-ai/claude-code`) | `local/<user>-claude` |
| `opencode` | [OpenCode Agent](https://opencode.ai) (`@opencode-ai`) | `local/<user>-opencode` |
| `hermes` | [Hermes Agent](https://hermes-agent.nousresearch.com/) | `local/<user>-hermes` |

Services share the same base image, security hardening, and workspace volume.

NOTE: Hermes is less restricted due to its base requirements. Treat it as less secure than the others. For now I'm not going to spend a bunch of time on it. Also I did not use their docker image since I wanted it to be as much like this structure as possible. This may prove to not be worth doing and I should just switch to their container. TBD on that.

NOTE: Opencode does not store its info in a single dir under $HOME.  It has specific definitions to mount up the various XDG style directories that it uses.


## Security Architecture

Note that not all images use these hardened features fully.

### 1. System Hardening
- SUID/SGID bits stripped from all binaries at build time.
- Privilege escalation tools removed (`su`, `mount`, `umount`, `passwd`, `newgrp`, `login`, `nsenter`, `unshare`, `setpriv`).
- Container filesystem mounted read-only; writable paths are explicit `tmpfs` mounts or volumes.
- PID limit of 150 enforced at the compose level.

### 2. Syscall Firewall — `src/fs-vault.c` (LD_PRELOAD)
- A shared library compiled at build time and injected via `/etc/ld.so.preload`. It intercepts `open`, `openat`, `fopen`, and their 64-bit variants for every process in the container. Any attempt to open a path containing `auth.json` is blocked with `EACCES` unless the calling process is the primary agent binary (`pi`/`/bin/pi`). This stops shell utilities (`cat`, `grep`) and arbitrary Node scripts from reading agent authentication tokens.
- NOTE: Claude does not really benefit from this

### 3. Application Firewall — `src/app-firewall.js` (Node.js `--require`)
- Loaded into every Node.js process via `NODE_OPTIONS=--require`. Wraps all major `fs` module methods (sync, async, and `fs.promises`) with a call-stack check. Any filesystem access to paths matching `.pi/agent`, `gh_*`, `.secrets`, or `.env` that originates from within an agent's `/tools/` call stack is thrown as an error. This prevents agent tool invocations from reading configuration and credential files while allowing the application itself to operate normally.
- NOTE: Claude does not really benefit from this

## Prerequisites

- Docker with Compose v2
- `ANTHROPIC_API_KEY` exported in your environment (for the `claude` service)

## Usage

```sh
# Build the default service (pi with WORKDIR=`.`)
make build

# Build the claude service
make SVC=claude build

# Run against a specific workspace directory
make SVC=claude WORKDIR=/path/to/project run

# Drop into a bash shell for debugging
make SVC=claude shell

# Rebuild with no layer cache
make update
```

The `WORKDIR` variable (default: `.`) is bind-mounted into the container at `/workspace`. You will likely always want to provide a valid path to your project.

For the claude environment, you would be asked every time for your configuration when you start the container, the `entrypoint.sh` is used to copy the latest .claude/backups file into .claude.json.  This is an imperfect hack to get around this. If you run the shell, you may want to run `/entrypoint.sh` to pick this up.

All containers have a `/entrypoint.sh` even if it does not do anything extra. This is provided for consistency.

## Project Layout

```
.
├── compose.yaml          # Docker Compose service definitions
├── Makefile              # Build / run helpers
├── claude/
│   ├── Dockerfile        # Claude Code container image
│   └── entrypoint.sh     # Restores ~/.claude.json from backup before launching claude
├── pi/
│   ├── Dockerfile        # Pi agent container image
│   ├── extensions        # Pi extensions that are copied to the container and loaded via the entrypoint
│   └── entrypoint.sh     # Launches pi directly
└── src/
    ├── app-firewall.js   # Node.js fs hook (application-layer sandbox)
    └── fs-vault.c        # LD_PRELOAD syscall hook (OS-layer sandbox)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_UID` | `1000` | UID to run the container process as |
| `HOST_GID` | `1000` | GID to run the container process as |
| `REAL_USER` | `node` | Username embedded in the image tag |
| `PARANOID_MODE` | `true` | Passed through to agent; interpretation is agent-specific |
| `WORKDIR`  | `.` | Host path bind-mounted as `/workspace` |
| `SVC` | `pi` | Compose service targeted by `make` commands |
