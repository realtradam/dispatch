/**
 * The LayoutProvider service contract (plan 02 §2.1) — what every layout
 * plugin implements (D-L6). Pure data shapes only: zero `@dispatch/*`
 * dependencies, safe for the frontend to import (the FE consumes the TREE
 * shapes; the provider OBJECT lives only behind the backend's service
 * registry — see `@dispatch/layout-provider-contract`, backend-only).
 *
 * `applyOps` joins this interface in plan 04 — same contract, additive.
 */

import type { LayoutTree } from "./tree";

/** Result of `setTree`: the validated + persisted tree, or the failure reason. */
export type SetTreeResult =
  | { readonly ok: true; readonly tree: LayoutTree }
  | { readonly ok: false; readonly error: string };

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
  /** Delete the stored record; next read re-seeds. Returns the fresh seed. */
  readonly resetTree: (workspaceId: string) => Promise<LayoutTree>;
}
