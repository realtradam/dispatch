/**
 * Tier classification checks — pure helpers over `Manifest` (no I/O, no
 * concrete feature names).
 *
 * The constitutional rule (AGENTS.md): **core depends only on core** — a
 * core→standard dependency edge is a classification bug. These helpers make
 * the rule machine-checkable: the plugin-verification harness (plan 08) and
 * any test can assert the bundled set is clean.
 */
import type { Manifest, PluginTier } from "../contracts/extension.js";

/** A core→standard dependency edge — a classification bug (AGENTS.md). */
export interface TierViolation {
  /** Id of the CORE extension declaring the dependency. */
  readonly id: string;
  /** Id of the STANDARD extension it depends on. */
  readonly depId: string;
}

/**
 * Find every core→standard dependency edge among `manifests`.
 *
 * Pure: input → output, no side effects. Deps whose id is not in `manifests`
 * are ignored here (unmet deps are the DAG resolver's job, not a tier
 * question); core→core and core→providers edges are not violations (the
 * rule this helper encodes is specifically core→standard — see AGENTS.md).
 * Duplicate ids are tolerated (first occurrence wins), mirroring
 * `resolveActivationOrderSafe`.
 */
export function findCoreToStandardDeps(manifests: readonly Manifest[]): TierViolation[] {
  const tierById = new Map<string, PluginTier>();
  for (const m of manifests) {
    if (!tierById.has(m.id)) tierById.set(m.id, m.tier);
  }
  const violations: TierViolation[] = [];
  for (const m of manifests) {
    if (m.tier !== "core") continue;
    for (const dep of m.dependsOn ?? []) {
      if (tierById.get(dep) === "standard") {
        violations.push({ id: m.id, depId: dep });
      }
    }
  }
  return violations;
}

/**
 * Assert the manifests contain NO core→standard dependency edge; throws with
 * a formatted list of every violating edge otherwise. The throwing
 * counterpart of `findCoreToStandardDeps` — what the verification harness
 * calls to fail a plugin (or a whole bundled set) that breaks the
 * constitutional rule.
 */
export function assertNoCoreToStandardDeps(manifests: readonly Manifest[]): void {
  const violations = findCoreToStandardDeps(manifests);
  if (violations.length > 0) {
    const detail = violations.map((v) => `"${v.id}" (core) → "${v.depId}" (standard)`).join(", ");
    throw new Error(
      `Core depends only on core (AGENTS.md) — core→standard dependency edges found: ${detail}`,
    );
  }
}
