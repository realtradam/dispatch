/**
 * The LayoutProvider service contract (plan 02 §2.1) — what every layout
 * plugin implements (D-L6). Pure data shapes only: zero `@dispatch/*`
 * dependencies, safe for the frontend to import (the FE consumes the TREE
 * shapes; the provider OBJECT lives only behind the backend's service
 * registry — see `@dispatch/layout-provider-contract`, backend-only).
 *
 * `applyOps` joins this interface in plan 04 — same contract, additive: the
 * plugin-facing op vocabulary (plan 01's `LayoutOp` + the `applyOp`/`applyOps`
 * dispatcher) applied ATOMICALLY by the provider (fold purely, validate the
 * folded result, then persist + broadcast ONCE — §4.2).
 */

import type { LayoutOp, LayoutTree } from "./tree";

/** Result of `setTree`: the validated + persisted tree, or the failure reason. */
export type SetTreeResult =
  | { readonly ok: true; readonly tree: LayoutTree }
  | { readonly ok: false; readonly error: string };

/**
 * Result of `applyOps` (plan 04 §4.2). Success carries the folded tree and
 * `applied` — the number of ops successfully processed (ALWAYS
 * `ops.length` on success: an `ensure*` op that found its view already
 * present counts as applied-but-unchanged). Failure is an atomic reject —
 * nothing was persisted, nothing broadcast — naming the failing op's index.
 *
 * `failedOp` is optional (rather than always required) because the FRONTEND
 * ABI's no-provider mapping (a 404 from `POST /workspaces/:id/layout/ops`
 * mapped to `{ ok: false, error: "no layout provider active" }`) fails
 * before any op runs — there is no failing op to name. Every failure that
 * comes from an actual provider ALWAYS sets it.
 */
export type ApplyOpsResult =
  | { readonly ok: true; readonly tree: LayoutTree; readonly applied: number }
  | { readonly ok: false; readonly error: string; readonly failedOp?: number };

/**
 * The service contract every layout plugin implements (D-L6).
 *
 * A provider owns per-workspace tree persistence for the workspaces it
 * serves. While it is provided (the plugin active), it is the single source
 * of truth for those trees; when it is absent, clients fall back to their
 * built-in default and edits become ephemeral.
 */
export interface LayoutProvider {
  /** Read the workspace's tree, seeding + materializing on first read. */
  readonly getTree: (workspaceId: string) => Promise<LayoutTree>;
  /** Validate + persist + broadcast. Never throws for bad trees. */
  readonly setTree: (workspaceId: string, tree: LayoutTree) => Promise<SetTreeResult>;
  /**
   * Apply op-vocabulary edits ATOMICALLY against the tree as read at apply
   * time (last-writer-wins — no CAS in v1). The ops fold PURELY over the
   * current tree; the folded result is validated; only then is it persisted
   * and broadcast ONCE. Any failed op (or an invalid folded result) rejects
   * the WHOLE batch: nothing persisted, no broadcast, `failedOp` naming the
   * offending index. `ensure*` ops on an already-present view count as
   * applied-but-unchanged. An EMPTY ops list succeeds with `applied: 0`
   * without persisting or broadcasting (no ops — no write). Never throws
   * for bad ops — they are `failedOp` failures.
   */
  readonly applyOps: (workspaceId: string, ops: readonly LayoutOp[]) => Promise<ApplyOpsResult>;
  /** Delete the stored record; next read re-seeds. Returns the fresh seed. */
  readonly resetTree: (workspaceId: string) => Promise<LayoutTree>;
}
