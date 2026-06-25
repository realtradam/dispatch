import { defineService } from "@dispatch/kernel";
import type { ExecBackend } from "./backend.js";

/**
 * Resolve an `ExecBackend` for a given computer.
 *
 * - `computerId` **undefined** → local (today's behavior; `LocalExecBackend`).
 * - `computerId` **set** → remote (SSH; wired by `host-bin` + the `ssh` package
 *   in a later wave — the `SshExecBackend` implements the same `ExecBackend`
 *   interface).
 *
 * The resolver is SYNCHRONOUS by design: it returns a backend whose methods are
 * async, so any remote connection acquisition happens lazily inside the first
 * backend method call, not at resolver-call time. This keeps the resolver
 * side-effect-free — merely resolving a backend never opens a connection; only
 * when a tool actually executes does the (remote) backend connect.
 */
export type ExecBackendResolver = (computerId?: string) => ExecBackend;

/**
 * Typed service handle for the `ExecBackend` resolver.
 *
 * The `exec-backend` extension provides this via `host.provideService`.
 * Tool extensions resolve their per-call backend from it (injected at
 * activation by `host-bin`).
 */
export const execBackendHandle = defineService<ExecBackendResolver>("exec-backend/resolver");
