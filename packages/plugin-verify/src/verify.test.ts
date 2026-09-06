/**
 * The verify-plugin harness's own gate (plan 08 §8.3): the scaffold PASSES,
 * and every negative fixture FAILS LOUDLY with a specific message. Wired
 * into `bun run test` — wrong plugins fail at test time, not at boot.
 */

import { execSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { defineFilter, type Extension, type Manifest } from "@dispatch/kernel";
import { extension as scaffold, manifest as scaffoldManifest } from "@dispatch/plugin-scaffold";
import { describe, expect, it } from "vitest";
import { checkManifest, checkTierDeps } from "./checks.js";
import { verifyDisposal } from "./disposal.js";
import { verifyPlugin } from "./verify.js";

// ── The scaffold passes (the drift-proof fixture guarantee) ───────────────────

describe("verifyPlugin — the canonical scaffold (plan 08 §8.1)", () => {
  it("passes every check: manifest, tier-deps, frontend, disposal (zero dangling, zero leaked surfaces)", async () => {
    // pluginDir: the scaffold package root — its frontend entry
    // (`frontend.js`) must be BUILT first (the scaffold's frontend-build
    // test builds it; the vitest file order in CI is not guaranteed, so
    // build here when missing). The scaffold is the drift-proof fixture:
    // a manifest declaring `frontend` must have a resolvable entry.
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "..", "plugin-scaffold");
    try {
      await stat(join(dir, "frontend.js"));
    } catch {
      execSync("bun run build:frontend", { cwd: dir, stdio: "pipe" });
    }
    const report = await verifyPlugin(scaffold, { pluginDir: dir });
    expect(report.pluginId).toBe("plugin-scaffold");
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("passes the disposal check repeatedly (a fresh host per run — no cross-run state)", async () => {
    for (let i = 0; i < 2; i++) {
      const result = await verifyDisposal(scaffold);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("survives the scaffold manifest being checked standalone (pure mirror, no host)", () => {
    expect(checkManifest(scaffoldManifest)).toEqual({ ok: true, errors: [] });
  });
});

// ── Negative fixtures — each violation fails LOUDLY with a clear message ─────

function makeExtension(manifest: Manifest, activate: Extension["activate"]): Extension {
  return { manifest, activate };
}

/** A scaffold manifest with the frontend section swapped in (plan 03 fixtures). */
function manifestWithFrontend(frontend: { apiVersion: string; entry: string }): Manifest {
  return { ...scaffoldManifest, frontend };
}

const baseManifest: Manifest = {
  id: "fixture-plugin",
  name: "Fixture Plugin",
  version: "1.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
};

describe("verifyPlugin — negative fixtures (fail loudly, plan 08 §8.3)", () => {
  it("a plugin that leaks a registration (a filter it never disposes) fails the disposal check, naming the kind and hook id", async () => {
    const leaker = makeExtension(baseManifest, (host) => {
      // Registers a filter and "forgets" the disposer — the classic leak.
      host.addFilter(defineFilter<string>("fixture/leak"), (v) => v);
    });
    const report = await verifyPlugin(leaker, { skipDisposal: false });
    expect(report.ok).toBe(false);
    const disposal = report.problems.filter((p) => p.check === "disposal");
    expect(disposal.length).toBeGreaterThan(0);
    expect(
      disposal.some((p) =>
        p.message.includes('dangling registration after deactivate(): filter "fixture/leak"'),
      ),
    ).toBe(true);
  });

  it("a plugin whose deactivate() throws still surfaces the dangling registrations (the host force-cleans)", async () => {
    const throwing = makeExtension(baseManifest, (host) => {
      host.addFilter(defineFilter<string>("fixture/leak-throw"), (v) => v);
    });
    // Give it a deactivate that throws — the unload must STILL report the leak.
    const ext: Extension = {
      ...throwing,
      deactivate: () => {
        throw new Error("boom");
      },
    };
    const result = await verifyDisposal(ext);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('"fixture/leak-throw"'))).toBe(true);
  });

  it("a core→standard dependency fails the tier check, naming the offending edge", () => {
    const coreWithStandardDep: Manifest = {
      ...baseManifest,
      id: "fixture-core",
      tier: "core",
      dependsOn: ["some-standard-plugin"],
    };
    const context: Manifest = { ...baseManifest, id: "some-standard-plugin", tier: "standard" };
    const result = checkTierDeps(coreWithStandardDep, [context]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('"fixture-core" (core) → "some-standard-plugin" (standard)');
    expect(result.errors[0]).toContain("Core depends only on core");
  });

  it("a missing required manifest field fails with the field named", () => {
    const { tier, ...withoutTier } = baseManifest;
    void tier;
    const result = checkManifest(withoutTier);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing or invalid required field "tier"');
  });

  it("an invalid tier value fails with the valid values listed", () => {
    const result = checkManifest({ ...baseManifest, tier: "superplugin" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('invalid "tier"');
    expect(result.errors[0]).toContain('"core", "providers", "standard"');
  });

  it("an unparseable apiVersion range fails loudly", () => {
    const result = checkManifest({ ...baseManifest, apiVersion: "not-a-range" });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('invalid apiVersion range "not-a-range"');
  });

  it("a runtime plugin contributing migrations fails (the host collects migrations before any runtime load)", () => {
    const result = checkManifest({
      ...baseManifest,
      contributes: { migrations: ["001-add-thing"] },
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("runtime plugins cannot contribute migrations");
  });

  it("an unmet dependsOn target is REPORTED (never a harness crash — the DAG pre-resolution)", async () => {
    const orphan = makeExtension({ ...baseManifest, dependsOn: ["not-in-the-load-set"] }, () => {});
    const result = await verifyDisposal(orphan);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes(
          'unmet dependencies: extension "fixture-plugin" depends on "not-in-the-load-set"',
        ),
      ),
    ).toBe(true);
  });

  it("a leaked SURFACE (service-mediated, invisible to the ledger) is caught by the catalog check", async () => {
    // A plugin that registers a surface and never deregisters it — the leak
    // the ledger CANNOT see (plan 01 §1.4). It must fail via the catalog
    // assertion, not the dangling list.
    const { createSurfaceRegistryExtension, surfaceRegistryHandle } = await import(
      "@dispatch/surface-registry"
    );
    const surfaceLeaker: Extension = {
      manifest: { ...baseManifest, id: "surface-leaker" },
      activate: (host) => {
        const registry = host.getService(surfaceRegistryHandle);
        registry.register({
          catalogEntry: {
            id: "leaked-surface",
            region: "side",
            title: "Leaked",
            scope: "global",
            pluginId: "surface-leaker",
          },
          getSpec: () => ({
            id: "leaked-surface",
            region: "side",
            title: "Leaked",
            fields: [],
          }),
          invoke: () => {},
        });
        // NO deregistration — the leak.
      },
    };
    const result = await verifyDisposal(surfaceLeaker, {
      environment: [createSurfaceRegistryExtension()],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('leaked surface "leaked-surface"'))).toBe(true);
  });

  it("the composite report aggregates problems from MULTIPLE checks with their check names", async () => {
    const badManifest = makeExtension(
      { ...baseManifest, version: "" }, // invalid required field
      () => {
        // ...AND a leaked registration.
      },
    );
    // The version is checked by the MIRROR at runtime (a tsc-typed manifest
    // would catch it at compile time; a JSON-authored one would not).
    const report = await verifyPlugin(badManifest, { skipDisposal: true });
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.check)).toContain("manifest");
    expect(report.problems.some((p) => p.message.includes('"version"'))).toBe(true);
  });
});

// ── Frontend fixtures (plan 03) — bad ranges / missing entries fail loudly ──

describe("verifyPlugin — frontend assertions (plan 03)", () => {
  it("an unparseable frontend.apiVersion range fails loudly (the checkManifest mirror)", () => {
    const result = checkManifest(
      manifestWithFrontend({ apiVersion: "^one", entry: "frontend.js" }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not a parseable frontend semver range");
  });

  it("an absolute frontend.entry fails the manifest check", () => {
    const result = checkManifest(manifestWithFrontend({ apiVersion: "^1", entry: "/etc/x.js" }));
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("must be relative to the plugin directory");
  });

  it("a missing entry FILE fails the frontend check, naming the expected path", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "verify-fe-"));
    try {
      const report = await verifyPlugin(
        makeExtension(
          { ...scaffoldManifest, frontend: { apiVersion: "^1", entry: "missing.js" } },
          () => {},
        ),
        { pluginDir: dir, skipDisposal: true },
      );
      expect(report.ok).toBe(false);
      expect(report.problems[0]?.check).toBe("frontend");
      expect(report.problems[0]?.message).toContain("does not exist");
      expect(report.problems[0]?.message).toContain("build:frontend");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a traversal entry (../) fails the frontend check (the host refuses it too)", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "verify-fe-"));
    try {
      const report = await verifyPlugin(
        makeExtension(
          { ...scaffoldManifest, frontend: { apiVersion: "^1", entry: "../evil.js" } },
          () => {},
        ),
        { pluginDir: dir, skipDisposal: true },
      );
      expect(report.ok).toBe(false);
      expect(report.problems[0]?.message).toContain("escapes the plugin directory");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
