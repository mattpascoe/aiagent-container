# agentharness-coms-protocol

Shared wire-protocol + registry + transport helpers for the
`agentharness-comms` layer that lets AI coding agents in different Docker
containers talk to each other peer-to-peer over Unix domain sockets.

This module is **framework-agnostic**: it has zero dependencies on Pi or
Claude Code. It can be imported from a Pi extension, a Claude MCP server,
or any other Node.js process.

## What's here

| File            | Purpose                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `envelopes.ts`  | Wire-protocol type definitions (`prompt`, `response`, `ping`, ack/nack/pong)     |
| `identity.ts`   | ULID, container ID resolution, socket/registry path helpers                      |
| `transport.ts`  | `readOneLine`, `sendEnvelope`, `bindEndpoint`, `writeAck`/`writeNack`            |
| `registry.ts`   | Atomic registry writes, heartbeat-based liveness, dead-letter queue              |
| `audit.ts`      | Append-only JSONL audit logger shared by both adapters                           |
| `index.ts`      | Barrel export — import everything from this file                                 |

## Design choices

- **Newline-delimited JSON** as the wire format. One connection = one request
  + one reply, then closed. Simple to debug with `nc -U`.
- **Socket paths namespaced by container ID**:
  `<COMS_DIR>/sockets/<container_id>/<session_id>.sock`. No two containers
  can collide, even if they happen to mint the same ULID.
- **Heartbeat-based liveness**, not PID signal. `process.kill(pid, 0)`
  fails across PID namespaces (each container has its own PID 1).
- **Atomic writes** via `write-to-tmp + rename` so concurrent readers
  (`coms_list`) never see a half-written registry file.

## Build

This module is consumed in source form (the Pi extension uses Bun's native
TS loader; the Claude MCP server compiles it via `tsc` at Docker build
time). To typecheck standalone:

```sh
NODE_ENV=development npm install
./node_modules/.bin/tsc --noEmit
```

`NODE_ENV=development` is required because this container sets
`NODE_ENV=production` globally, which makes npm skip devDependencies.

## Smoke test

```sh
./node_modules/.bin/tsc --noEmit false --module nodenext --target es2022 --outDir dist --rootDir . --skipLibCheck
node dist/_smoke.js
```

The smoke test runs a full UDS round-trip, registry CRUD, name collision
resolution, and audit log append, then exits 0 on success.

## Cross-container caveats

- The shared directory (`<COMS_DIR>`, default `~/.agentharness-coms`) must
  be a **bind-mounted host volume** in every container that runs an
  adapter, at the same absolute path inside each container.
- The UID inside each container must match (the `Makefile` already enforces
  this via `HOST_UID`/`HOST_GID`).
- UDS over a shared bind mount works on Linux when both containers share
  the volume and UIDs align. Tested in this repo's Docker compose setup.
