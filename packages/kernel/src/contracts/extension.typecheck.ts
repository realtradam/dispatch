/**
 * Type-level contract fixtures for `Manifest` (§10.4) — compiled by `tsc -b`
 * but never imported at runtime.
 *
 * This file exists because `*.test.ts` files are EXCLUDED from the project
 * typecheck (`tsconfig.base.json` → `exclude`), so a negative compile test
 * cannot live in a test file. The `@ts-expect-error` directive below is the
 * test itself, enforced in both directions by `tsc`:
 * - if `tier` ever becomes optional again, the negative literal below
 *   compiles cleanly, the directive goes unused, and `tsc` fails ("Unused
 *   '@ts-expect-error' directive");
 * - while `tier` is required, the directive is "used" and `tsc` passes.
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
