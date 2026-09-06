/**
 * Type-level contract fixtures for `Manifest` (§10.4) — compiled by `tsc -b`
 * but never imported at runtime.
 *
 * This file exists because `*.test.ts` files are EXCLUDED from the project
 * typecheck (`tsconfig.base.json` → `exclude`), so a negative compile test
 * cannot live in a test file. Each `@ts-expect-error` directive below is the
 * test itself, enforced in both directions by `tsc`:
 * - if a required field ever becomes optional again, the negative literal
 *   below compiles cleanly, the directive goes unused, and `tsc` fails
 *   ("Unused '@ts-expect-error' directive");
 * - while the field is required, the directive is "used" and `tsc` passes.
 * Every §10.4 REQUIRED field (id, name, version, apiVersion, tier, trust)
 * has its own fixture (plan 08 §8.4 completed the set).
 *
 * Do not import from this module; it has no runtime value.
 */
import type { Manifest } from "./extension.js";

// Negative fixture: a manifest WITHOUT `tier` must fail `tsc` (tier is
// required on every extension — plan 02 §10.4). No `as Manifest` cast here —
// an assertion would silence exactly the error this fixture must keep alive.
// @ts-expect-error — `tier` is REQUIRED (§10.4): omitting it must fail tsc.
export const manifestMissingTier: Manifest = {
  apiVersion: "^0.1.0",
  id: "typecheck-fixture-missing-tier",
  name: "Typecheck Fixture (missing tier)",
  trust: "bundled",
  version: "0.0.0",
};

// Plan 08 §8.4 completion: the REQUIRED set is { id, name, version,
// apiVersion, tier, trust } — each remaining required field gets the same
// negative fixture, so a malformed manifest is a COMPILE error (tsc) before
// the verify-plugin harness ever runs. Same both-direction enforcement: if a
// field ever becomes optional, its directive goes unused and `tsc -b` fails.

// @ts-expect-error — `id` is REQUIRED (§10.4).
export const manifestMissingId: Manifest = {
  apiVersion: "^0.1.0",
  name: "Typecheck Fixture (missing id)",
  tier: "standard",
  trust: "bundled",
  version: "0.0.0",
};

// @ts-expect-error — `name` is REQUIRED (§10.4).
export const manifestMissingName: Manifest = {
  apiVersion: "^0.1.0",
  id: "typecheck-fixture-missing-name",
  tier: "standard",
  trust: "bundled",
  version: "0.0.0",
};

// @ts-expect-error — `version` is REQUIRED (§10.4).
export const manifestMissingVersion: Manifest = {
  apiVersion: "^0.1.0",
  id: "typecheck-fixture-missing-version",
  name: "Typecheck Fixture (missing version)",
  tier: "standard",
  trust: "bundled",
};

// @ts-expect-error — `apiVersion` is REQUIRED (§10.4).
export const manifestMissingApiVersion: Manifest = {
  id: "typecheck-fixture-missing-api-version",
  name: "Typecheck Fixture (missing apiVersion)",
  tier: "standard",
  trust: "bundled",
  version: "0.0.0",
};

// @ts-expect-error — `trust` is REQUIRED (§10.4).
export const manifestMissingTrust: Manifest = {
  apiVersion: "^0.1.0",
  id: "typecheck-fixture-missing-trust",
  name: "Typecheck Fixture (missing trust)",
  tier: "standard",
  version: "0.0.0",
};

// Positive fixture: the minimum VALID manifest — every required field present
// (`id`, `name`, `version`, `apiVersion`, `tier`, `trust`), everything else
// optional (§10.4 rationale).
export const validMinimalManifest: Manifest = {
  apiVersion: "^0.1.0",
  id: "typecheck-fixture-valid",
  name: "Typecheck Fixture (valid)",
  tier: "standard",
  trust: "bundled",
  version: "0.0.0",
};
