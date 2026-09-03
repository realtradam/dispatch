/**
 * Pure, pre-load checks for the verify-plugin harness (plan 08 §8.3).
 *
 * `checkManifest` MIRRORS the required-set portion of the plan-04
 * `validatePluginManifest` (host-bin/src/plugin-reconcile.ts): the manifest
 * format is FROZEN (plan 02), so the two agree by construction. It is
 * duplicated rather than imported because plugin-verify must stay a leaf
 * package — depending on host-bin (the composition root, which depends on
 * everything) would invert the dependency graph.
 *
 * Every check is input → output (no I/O, no host) so failures are testable
 * without a runtime.
 */

import {
  assertNoCoreToStandardDeps,
  findCoreToStandardDeps,
  isApiVersionCompatible,
  type Manifest,
  type TierViolation,
} from "@dispatch/kernel";

/** The outcome of a single harness check. */
export interface CheckResult {
  readonly ok: boolean;
  /** Human-readable, SPECIFIC failure messages (what is wrong, and what is expected). */
  readonly errors: readonly string[];
}

const VALID_TIERS: readonly string[] = ["core", "providers", "standard"];
const VALID_TRUST: readonly string[] = ["bundled", "local", "external"];

/** The §10.4 REQUIRED manifest set — every field the host needs to classify and gate a plugin. */
export const REQUIRED_MANIFEST_FIELDS: readonly string[] = [
  "id",
  "name",
  "version",
  "apiVersion",
  "tier",
  "trust",
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
}

/**
 * Manifest completeness + validity — the harness's mirror of the plan-04
 * `validatePluginManifest` required set. Takes an ALREADY-OBJECT value (the
 * parsed manifest.json, or a `Manifest` from code) so this stays pure.
 *
 * Checks: every required field present + well-formed; `tier` is one of the
 * three valid values; `trust` is a valid value; `apiVersion` is a PARSEABLE
 * range (compatibility with the kernel version is a boot-time status, not a
 * validation error — mirrors plan 04); `dependsOn` is well-formed when
 * present; runtime plugins cannot contribute migrations (the host collects
 * migrations at createHost() time — a runtime declaration would be silently
 * ignored, so it fails loudly instead).
 */
export function checkManifest(value: unknown): CheckResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  const raw = value as Record<string, unknown>;
  const errors: string[] = [];

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!isNonEmptyString(raw[field])) {
      errors.push(`missing or invalid required field "${field}"`);
    }
  }
  if (raw.tier !== undefined && !VALID_TIERS.includes(raw.tier as string)) {
    errors.push(
      `invalid "tier": ${JSON.stringify(raw.tier)} — expected one of ${VALID_TIERS.map((t) => `"${t}"`).join(", ")}`,
    );
  }
  if (raw.trust !== undefined && !VALID_TRUST.includes(raw.trust as string)) {
    errors.push(
      `invalid "trust": ${JSON.stringify(raw.trust)} — expected one of ${VALID_TRUST.map((t) => `"${t}"`).join(", ")}`,
    );
  }
  if (isNonEmptyString(raw.apiVersion)) {
    try {
      isApiVersionCompatible(raw.apiVersion, "0.0.0");
    } catch {
      errors.push(`invalid apiVersion range "${raw.apiVersion}" — not a parseable semver range`);
    }
  }
  if (raw.dependsOn !== undefined && !isStringArray(raw.dependsOn)) {
    errors.push('"dependsOn" must be an array of non-empty strings');
  }
  if (raw.contributes !== undefined) {
    if (!raw.contributes || typeof raw.contributes !== "object" || Array.isArray(raw.contributes)) {
      errors.push('"contributes" must be an object');
    } else if ((raw.contributes as Record<string, unknown>).migrations !== undefined) {
      errors.push(
        "runtime plugins cannot contribute migrations (the host collects migrations at createHost() time, before any runtime load)",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The constitutional tier check (AGENTS.md: core depends only on core) over
 * the plugin under test TOGETHER WITH the set it will load into. Runs the
 * kernel's throwing `assertNoCoreToStandardDeps` and converts a violation
 * into a `CheckResult` instead of a throw — the harness reports, the caller
 * decides.
 *
 * `context` is the rest of the set (e.g. the bundled manifests); the plugin
 * under test's own manifest is appended. A core→standard edge FROM the plugin
 * (or through the combined set) fails with the offending edges named.
 */
export function checkTierDeps(plugin: Manifest, context: readonly Manifest[] = []): CheckResult {
  const manifests = [plugin, ...context];
  try {
    assertNoCoreToStandardDeps(manifests);
  } catch {
    const edges = findCoreToStandardDeps(manifests);
    const detail = edges
      .map((v: TierViolation) => `"${v.id}" (core) → "${v.depId}" (standard)`)
      .join(", ");
    return {
      ok: false,
      errors: [
        `Core depends only on core (AGENTS.md) — core→standard dependency edge(s) found: ${detail}`,
      ],
    };
  }
  return { ok: true, errors: [] };
}
