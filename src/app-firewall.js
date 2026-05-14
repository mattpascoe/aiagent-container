const fs = require("fs");

function block(p) {
    if (!p) return;
    const s = p.toString();
    
    // Target the sensitive configuration and credential paths
    if (s.includes(".pi/agent") || s.includes("gh_") || s.includes(".secrets") || s.includes(".env")) {
        // If the execution stack originates from the AI agent's tools, block it.
        // This allows the core application (like /login) to operate normally.
        if (new Error().stack.includes("/tools/")) {
            throw new Error("[SYSTEM BLOCK] Agent is sandboxed and cannot access configuration or credential files.");
        }
    }
}

// Intercept all major filesystem operations
const hooks = [
    "readFile", "readFileSync", "createReadStream", 
    "writeFile", "writeFileSync", "createWriteStream", "appendFile", "appendFileSync",
    "open", "openSync", 
    "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync",
    "readdir", "readdirSync"
];

hooks.forEach(fn => {
    // Hook standard fs callbacks/sync methods
    if (fs[fn]) {
        const orig = fs[fn];
        fs[fn] = function(...args) { 
            block(args[0]); 
            return orig.apply(this, args); 
        };
    }
    // Hook fs.promises methods
    if (fs.promises && fs.promises[fn]) {
        const origP = fs.promises[fn];
        fs.promises[fn] = function(...args) { 
            block(args[0]); 
            return origP.apply(this, args); 
        };
    }
});