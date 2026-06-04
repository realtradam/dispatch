// @dispatch/kernel — the minimal runtime core.
//
// Exposes the ABI (contracts) that every extension and the runtime compile
// against. Host, runtime, and bus implementations are added by their own
// owner-agents and re-exported here as they land.

export * from "./contracts/index.js";
