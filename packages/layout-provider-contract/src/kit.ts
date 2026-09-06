/**
 * `createLayoutProvider` — the provider kit (plan 02 §2.2). Every layout
 * plugin composes this kit, so persistence/coherence behavior is identical
 * and tested once, not reimplemented per plugin (decision 1):
 *
 * - workspace-keyed persistence over an injected `StorageNamespace`
 *   (`tree:<workspaceId>` → JSON);
 * - seed-on-miss from the plugin's supplied default tree, materialized on
 *   first read (read-through — the plan-06 precedent);
 * - structural `validateTree` on every write (the backend never knows the
 *   frontend's view registry — unknown view ids are the renderer's
 *   fallback-tile concern, NOT a validation failure);
 * - ATOMIC `applyOps` (plan 04 §4.2): the op vocabulary folds PURELY over the
 *   tree as read at apply time; the folded result validates; only then does
 *   it persist + broadcast ONCE (a failed op persists nothing and names its
 *   index). Implemented here ONCE — every provider inherits it;
 * - outward `layout` change events after every successful write (§2.5) —
 *   full tree, no patch protocol (decision 7);
 * - route handlers for the well-known HTTP routes (§2.3): GET/PUT/DELETE
 *   `/workspaces/:id/layout`. The transport (transport-http) mounts them as
 *   thin shells over a PER-REQUEST, PER-WORKSPACE provider lookup (the
 *   layout-provider REGISTRY's `providerFor`), so the routes 404 for a
 *   workspace with no enabled layout plugin and start serving — for exactly
 *   the workspaces that enable one — without a restart.
 *
 * Deps are INJECTED (effects at the edges): the plugin wires `storage` from
 * `host.storage(<its namespace>)`, `emitChange` from the kernel's event-hook
 * bus (`(message) => host.emit(layoutChanged, message)` — the live
 * `extensions-changed` path), `logger` from `host.logger`, and passes its
 * default tree (the plan-02 seed plugin uses `DEFAULT_LAYOUT` — the contract
 * package's single source of truth).
 *
 * Activation (per workspace) is NOT the kernel's single-slot registry
 * anymore: layout plugins register into the layout-provider REGISTRY
 * (`createLayoutProviderRegistry`, provided by the `layout-provider-registry`
 * extension) and the workspace's per-workspace enablement state picks the
 * ONE active provider — multiple layout plugins coexist loaded, exactly one
 * serves each workspace.
 */

import type { Logger, StorageNamespace } from "@dispatch/kernel";
import type {
  ApplyOpsResult,
  LayoutOp,
  LayoutProvider,
  LayoutTree,
  SetTreeResult,
} from "@dispatch/layout-contract";
import { applyOp, validateTree } from "@dispatch/layout-contract";
import type { LayoutChangedMessage } from "@dispatch/transport-contract";

/** Storage-key prefix — `tree:<workspaceId>` holds the workspace's JSON tree. */
const KEY_PREFIX = "tree:";

function storageKey(workspaceId: string): string {
  return `${KEY_PREFIX}${workspaceId}`;
}

export interface LayoutProviderDeps {
  /** The plugin's OWN storage namespace (`host.storage("layout-chat")`). */
  readonly storage: StorageNamespace;
  /** The tree a fresh workspace is seeded with (read-through on first read). */
  readonly defaultTree: LayoutTree;
  /**
   * The outward change emitter — wired by the plugin from the kernel's
   * event-hook bus (`host.emit(layoutChanged, message)`); transport-ws
   * broadcasts the payload verbatim. Called EXACTLY ONCE per successful
   * write, never on reads (a read-triggered seed is not a user write —
   * emitting would broadcast on every fresh-workspace GET).
   */
  readonly emitChange: (message: LayoutChangedMessage) => void;
  readonly logger: Logger;
}

/** Minimal structural check that a parsed storage record is a layout tree. */
function isTreeShape(value: unknown): value is LayoutTree {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { version?: unknown; root?: unknown };
  return record.version === 1 && typeof record.root === "object" && record.root !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort op label for error messages (wire ops may be junk). */
function opTypeName(op: LayoutOp): string {
  return typeof op === "object" && op !== null && "type" in op ? String(op.type) : "unknown";
}

/**
 * Build the `LayoutProvider` implementation. Pure decision logic over the
 * injected edges — no ambient state beyond the plugin's own storage.
 */
export function createLayoutProvider(deps: LayoutProviderDeps): LayoutProvider {
  const { storage, defaultTree, emitChange, logger } = deps;

  /** Persist + emit the change event EXACTLY ONCE per successful write. */
  async function persist(workspaceId: string, tree: LayoutTree): Promise<void> {
    await storage.set(storageKey(workspaceId), JSON.stringify(tree));
    // The kernel's hook bus is error-isolated; the guard keeps "never throws
    // for bad luck" true even for a misbehaving injected emitter.
    try {
      emitChange({ type: "layout", workspaceId, tree });
    } catch (err) {
      logger.error("layout-provider: change emitter threw (write persisted)", { err });
    }
  }

  /** Read-through miss handling: return null for absent AND corrupt records. */
  async function readStored(workspaceId: string): Promise<LayoutTree | null> {
    let raw: string | null;
    try {
      raw = await storage.get(storageKey(workspaceId));
    } catch (err) {
      logger.error("layout-provider: storage read failed", { err });
      throw err;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isTreeShape(parsed)) return parsed;
      logger.warn("layout-provider: corrupt stored tree (bad shape) — re-seeding", {
        workspaceId,
      });
      return null;
    } catch {
      logger.warn("layout-provider: corrupt stored tree (bad JSON) — re-seeding", { workspaceId });
      return null;
    }
  }

  return {
    async getTree(workspaceId: string): Promise<LayoutTree> {
      const stored = await readStored(workspaceId);
      if (stored !== null) return stored;
      // Seed-on-miss: materialize the default tree for this workspace so the
      // first read pins the seed (idempotent — the next read finds it).
      await storage.set(storageKey(workspaceId), JSON.stringify(defaultTree));
      logger.debug("layout-provider: seeded workspace", { workspaceId });
      return defaultTree;
    },

    async setTree(workspaceId: string, tree: LayoutTree): Promise<SetTreeResult> {
      // Structural validation on EVERY write path (not just HTTP): unknown
      // view ids are fine (renderer fallback concern); structural violations
      // (empty splits, duplicate ids, bad sizes, …) are rejected.
      const validation = validateTree(tree);
      if (!validation.ok) {
        return { ok: false, error: validation.errors.join("; ") };
      }
      await persist(workspaceId, tree);
      return { ok: true, tree };
    },

    async applyOps(workspaceId: string, ops: readonly LayoutOp[]): Promise<ApplyOpsResult> {
      // ATOMIC (plan 04 §4.2): fold the ops over the tree AS READ at apply
      // time (read-through — a fresh workspace is seeded first), purely, with
      // per-op failure capture. Nothing touches storage until every op has
      // folded and the folded result validates.
      const current = await this.getTree(workspaceId);
      let folded = current;
      for (const [index, op] of ops.entries()) {
        let result: ReturnType<typeof applyOp>;
        try {
          // The op vocabulary is TOTAL for well-typed ops, but ops arriving
          // over the wire (or from plugin JS) are untyped at this boundary —
          // junk (a missing/garbage ref, a bad shape) surfaces as a THROW
          // from the pure op, and must become a failed op, never a crash.
          result = applyOp(folded, op);
        } catch (err) {
          return {
            ok: false,
            error: `op ${index} (${opTypeName(op)}) failed: ${err instanceof Error ? err.message : String(err)}`,
            failedOp: index,
          };
        }
        if (!result.ok) {
          return { ok: false, error: `op ${index} failed: ${result.error}`, failedOp: index };
        }
        folded = result.tree;
      }
      // Validate the FOLDED result before anything persists: ops are locally
      // correct but their composition could still violate the schema.
      const validation = validateTree(folded);
      if (!validation.ok) {
        return {
          ok: false,
          error: `ops produced an invalid tree: ${validation.errors.join("; ")}`,
          ...(ops.length > 0 ? { failedOp: ops.length - 1 } : {}),
        };
      }
      // An empty batch is a successful READ, not a write: nothing changed, so
      // nothing persists and nothing broadcasts (one event per WRITE).
      if (ops.length === 0) {
        return { ok: true, tree: folded, applied: 0 };
      }
      await persist(workspaceId, folded);
      return { ok: true, tree: folded, applied: ops.length };
    },

    async resetTree(workspaceId: string): Promise<LayoutTree> {
      await storage.delete(storageKey(workspaceId));
      // The next read re-seeds via read-through; the event carries the fresh
      // seed so every connected client resets to it immediately.
      try {
        emitChange({ type: "layout", workspaceId, tree: defaultTree });
      } catch (err) {
        logger.error("layout-provider: change emitter threw (reset persisted)", { err });
      }
      return defaultTree;
    },
  };
}

// ── Well-known HTTP route handlers (§2.3) ───────────────────────────────────

/**
 * One route outcome: an HTTP status + a JSON body — `{ tree }` (GET/PUT/
 * DELETE), `{ tree, applied }` (POST ops), or `{ error, failedOp? }`.
 */
export interface LayoutRouteResult {
  readonly status: 200 | 400 | 404 | 500;
  readonly body:
    | { readonly tree: LayoutTree; readonly applied?: number }
    | { readonly error: string; readonly failedOp?: number };
}

export interface LayoutRouteHandlers {
  /** GET /workspaces/:id/layout — read (seeds a fresh workspace); 404 when absent. */
  readonly get: (workspaceId: string) => Promise<LayoutRouteResult>;
  /** PUT /workspaces/:id/layout — body `{ tree }`; 200 `{ tree }` / 400 `{ error }`. */
  readonly put: (workspaceId: string, body: unknown) => Promise<LayoutRouteResult>;
  /** DELETE /workspaces/:id/layout — re-seed on next read; returns the fresh seed. */
  readonly delete: (workspaceId: string) => Promise<LayoutRouteResult>;
  /**
   * POST /workspaces/:id/layout/ops — body `{ ops: LayoutOp[] }` (plan 04);
   * the SAME kit `applyOps` as the service (one code path, two doors).
   * 200 `{ tree, applied }` / 400 `{ error, failedOp? }` / 404 no provider.
   */
  readonly ops: (workspaceId: string, body: unknown) => Promise<LayoutRouteResult>;
}

const NO_PROVIDER_BODY = { error: "No layout plugin is enabled in this workspace" } as const;

/** Validate a PUT body's shape: `{ tree: LayoutTree }` with version 1 + a root. */
export function parseTreeBody(
  body: unknown,
):
  | { readonly ok: true; readonly tree: LayoutTree }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be a JSON object" };
  if (!isTreeShape(body.tree)) {
    return { ok: false, error: "Body must be { tree: { version: 1, root: … } }" };
  }
  return { ok: true, tree: body.tree };
}

/** The op-vocabulary discriminants accepted at the ops door (plan 04 §4.1). */
const KNOWN_OP_TYPES: ReadonlySet<string> = new Set([
  "replaceView",
  "insertLeaf",
  "insertPanel",
  "removeNode",
  "moveNode",
  "setSizes",
  "splitLeaf",
  "ensureLeaf",
  "ensurePanel",
]);

/**
 * Validate a POST ops body's shape: `{ ops: LayoutOp[] }` where every entry
 * is an object with a KNOWN `type` discriminant. Deep validation (refs,
 * indices, sizes) is the fold's job — a known-typed op with junk fields is a
 * `failedOp` 400 from `applyOps`, not a body rejection.
 */
export function parseOpsBody(
  body: unknown,
):
  | { readonly ok: true; readonly ops: readonly LayoutOp[] }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(body)) return { ok: false, error: "Request body must be a JSON object" };
  if (!Array.isArray(body.ops)) return { ok: false, error: "Body must be { ops: [...] }" };
  for (const [index, op] of body.ops.entries()) {
    if (!isRecord(op) || typeof op.type !== "string" || !KNOWN_OP_TYPES.has(op.type)) {
      return {
        ok: false,
        error: `ops[${index}] is not a layout op (unknown or missing "type" discriminant)`,
      };
    }
  }
  return { ok: true, ops: body.ops as readonly LayoutOp[] };
}

/**
 * Route handlers for the well-known layout routes, bound to a PER-REQUEST,
 * PER-WORKSPACE provider lookup (the transport resolves the workspace's
 * ONE enabled layout plugin through the layout-provider registry's
 * `providerFor`). Every handler degrades to 404 while the workspace has no
 * enabled layout plugin — the frontend's no-provider signal — and maps
 * provider outcomes to statuses: 200 with the tree, 400 with the validation
 * error, 500 on storage failure.
 */
export function createLayoutRouteHandlers(deps: {
  readonly getProvider: (workspaceId: string) => Promise<LayoutProvider | undefined>;
  readonly logger: Logger;
}): LayoutRouteHandlers {
  const { getProvider, logger } = deps;

  async function withProvider(
    workspaceId: string,
    run: (provider: LayoutProvider) => Promise<LayoutRouteResult>,
  ): Promise<LayoutRouteResult> {
    const provider = await getProvider(workspaceId);
    if (provider === undefined) {
      return { status: 404, body: NO_PROVIDER_BODY };
    }
    try {
      return await run(provider);
    } catch (err) {
      logger.error("layout-provider: route failure", { err, workspaceId });
      return { status: 500, body: { error: "Layout storage failure" } };
    }
  }

  return {
    get: (workspaceId) =>
      withProvider(workspaceId, async (provider) => ({
        status: 200 as const,
        body: { tree: await provider.getTree(workspaceId) },
      })),

    put: (workspaceId, body) =>
      withProvider(workspaceId, async (provider) => {
        const parsed = parseTreeBody(body);
        if (!parsed.ok) return { status: 400 as const, body: { error: parsed.error } };
        const result = await provider.setTree(workspaceId, parsed.tree);
        return result.ok
          ? { status: 200 as const, body: { tree: result.tree } }
          : { status: 400 as const, body: { error: result.error } };
      }),

    delete: (workspaceId) =>
      withProvider(workspaceId, async (provider) => ({
        status: 200 as const,
        body: { tree: await provider.resetTree(workspaceId) },
      })),

    ops: (workspaceId, body) =>
      withProvider(workspaceId, async (provider) => {
        const parsed = parseOpsBody(body);
        if (!parsed.ok) return { status: 400 as const, body: { error: parsed.error } };
        const result = await provider.applyOps(workspaceId, parsed.ops);
        return result.ok
          ? { status: 200 as const, body: { tree: result.tree, applied: result.applied } }
          : {
              status: 400 as const,
              body: {
                error: result.error,
                ...(result.failedOp === undefined ? {} : { failedOp: result.failedOp }),
              },
            };
      }),
  };
}
