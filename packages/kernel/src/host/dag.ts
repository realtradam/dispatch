import type { Manifest } from "../contracts/extension.js";

export function resolveActivationOrder(manifests: readonly Manifest[]): Manifest[] {
  const byId = new Map<string, Manifest>();
  for (const m of manifests) {
    if (byId.has(m.id)) {
      throw new Error(`Duplicate extension id: "${m.id}"`);
    }
    byId.set(m.id, m);
  }

  for (const m of manifests) {
    for (const dep of m.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Extension "${m.id}" depends on "${dep}", which is not available.`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const m of manifests) {
    inDegree.set(m.id, 0);
    dependents.set(m.id, []);
  }

  for (const m of manifests) {
    for (const dep of m.dependsOn ?? []) {
      const list = dependents.get(dep);
      if (list !== undefined) list.push(m.id);
      inDegree.set(m.id, (inDegree.get(m.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const result: Manifest[] = [];
  let idx = 0;
  while (idx < queue.length) {
    const id = queue[idx];
    if (id === undefined) break;
    idx++;
    const m = byId.get(id);
    if (m === undefined) continue;
    result.push(m);
    for (const dep of dependents.get(id) ?? []) {
      const newDeg = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDeg);
      if (newDeg === 0) queue.push(dep);
    }
  }

  if (result.length !== manifests.length) {
    const remaining = manifests.filter((m) => !result.some((r) => r.id === m.id));
    const ids = remaining.map((m) => m.id).join(", ");
    throw new Error(`Dependency cycle detected among extensions: ${ids}`);
  }

  return result;
}

// --- Non-throwing resolution (runtime load path) ---

/** Outcome of the non-throwing dependency resolution. */
export interface DagResolution {
  /** Manifests that resolved, in dependency-safe activation order. */
  readonly ordered: Manifest[];

  /**
   * Manifests that could not be resolved, with the deps that are missing
   * (neither resolved within `manifests` nor listed in `satisfied`).
   * Includes both genuinely-unmet deps and members of dependency cycles
   * (a cycle member's missing list is populated from its unresolved,
   * in-cycle deps).
   */
  readonly unmet: ReadonlyArray<{
    readonly manifest: Manifest;
    readonly missing: readonly string[];
  }>;
}

export interface ResolveActivationOrderSafeOpts {
  /**
   * Extension ids treated as already available (e.g. currently-loaded
   * extensions when resolving a newly-loaded one at runtime). Deps listed
   * here do not have to appear in `manifests`.
   */
  readonly satisfied?: readonly string[];
}

/**
 * Non-throwing dependency resolution — the runtime counterpart of
 * `resolveActivationOrder`. Instead of throwing on unmet deps or cycles, it
 * reports them: unresolvable manifests land in `unmet` with the deps that
 * are missing, and everything that resolved comes back in `ordered` in a
 * dependency-safe activation order. The boot path keeps the throwing
 * `resolveActivationOrder`; the runtime load/unload engine uses this variant
 * to route problems into the disabled-with-reason list instead.
 *
 * Pure: input → output, no side effects. Duplicate ids in `manifests` are
 * tolerated (first occurrence wins); the runtime host paths cannot produce
 * them (the host refuses loading an id that is already loaded).
 */
export function resolveActivationOrderSafe(
  manifests: readonly Manifest[],
  opts?: ResolveActivationOrderSafeOpts,
): DagResolution {
  const satisfied = new Set<string>(opts?.satisfied ?? []);
  const byId = new Map<string, Manifest>();
  for (const m of manifests) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }

  const missingDeps = (m: Manifest, resolved: ReadonlySet<string>): string[] =>
    (m.dependsOn ?? []).filter((d) => !resolved.has(d));

  // Fixpoint: repeatedly activate any manifest whose deps are all available
  // (satisfied externally or resolved earlier in this run).
  const ordered: Manifest[] = [];
  const resolved = new Set<string>(satisfied);
  const remaining = [...byId.values()];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; i++) {
      const m = remaining[i];
      if (m === undefined) continue;
      if (missingDeps(m, resolved).length === 0) {
        ordered.push(m);
        resolved.add(m.id);
        remaining.splice(i, 1);
        i--;
        progressed = true;
      }
    }
  }

  // Whatever remains is unmet: missing deps are those still unresolved.
  // (Members of a dependency cycle land here too — all their deps are
  // unresolved because none of the cycle ever activates.)
  const unmet = remaining.map((m) => ({ manifest: m, missing: missingDeps(m, resolved) }));

  return { ordered, unmet };
}
