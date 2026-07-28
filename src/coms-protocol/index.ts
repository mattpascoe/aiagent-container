/**
 * coms-protocol/index.ts
 *
 * Barrel export. Import from this file rather than reaching into the
 * individual modules so consumers see a stable surface.
 *
 *   import {
 *     ulid, resolveContainerId, resolveComsDir,
 *     makeEndpoint, registryFilePath,
 *     readOneLine, sendEnvelope, bindEndpoint, writeAck, writeNack,
 *     writeRegistryEntry, readAllRegistryEntries, pruneDeadEntries,
 *     resolveUniqueName, appendAudit,
 *   } from "./coms-protocol/index.js";
 */

export * from "./envelopes.js";
export * from "./identity.js";
export * from "./transport.js";
export * from "./registry.js";
export * from "./audit.js";
export * from "./gc.js";
