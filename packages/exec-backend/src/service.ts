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

/**
 * A factory the `ssh` extension provides: given a computerId (SSH alias),
 * returns the remote `ExecBackend`. Absent (ssh not loaded) → remote execution
 * is unconfigured.
 *
 * This is a **consumer-defined handle**: `exec-backend` (a core extension)
 * declares it, and the `ssh` extension (a standard extension, built in a later
 * wave) `host.provideService`s it. That direction (standard → core, consumer
 * defines / provider implements) is the only layering that keeps the kernel free
 * of any concrete feature name — `exec-backend` owns the seam, `ssh` plugs in.
 *
 * The resolver looks this up LAZILY at resolve time (tool-execute time, after
 * all extensions have activated), so missing-the-provider degrades gracefully
 * rather than crashing activation.
 */
export const remoteExecBackendFactoryHandle = defineService<(computerId: string) => ExecBackend>(
	"exec-backend/remote-factory",
);
