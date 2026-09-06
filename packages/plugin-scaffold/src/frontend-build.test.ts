/**
 * The scaffold's FRONTEND module build (plan 03) — the CI-relevant spike
 * coverage: the canned vite lib config produces `frontend.js` (ONE standalone
 * ESM, svelte fully externalized — the import-map contract), and the module
 * exports `default.activate`. Also runs verify-plugin over the scaffold
 * WITH its directory — the harness's frontend assertions (parseable
 * `frontend.apiVersion` + a resolvable `frontend.entry`) must pass on the
 * canonical fixture.
 */
import { execSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const frontendJs = join(pkgRoot, "frontend.js");

async function build(): Promise<void> {
  execSync("bun run build:frontend", { cwd: pkgRoot, stdio: "pipe" });
}

describe("the scaffold's frontend module (plan 03)", () => {
  it("builds to ONE standalone ESM with svelte externalized", async () => {
    await build();
    const s = await stat(frontendJs);
    expect(s.isFile()).toBe(true);
    const code = await readFile(frontendJs, "utf8");
    // The import-map contract: the ONLY bare specifiers are svelte's —
    // the host's map resolves them to the app's own runtime instances.
    const specifiers = [...code.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const bare = specifiers.filter(
      (spec): spec is string => spec !== undefined && !spec.startsWith("."),
    );
    expect(bare.length).toBeGreaterThan(0);
    for (const spec of bare) {
      expect(spec, `non-svelte bare import "${spec}" would bundle a second runtime`).toMatch(
        /^svelte($|\/)/,
      );
    }
  });

  it("exports default.activate (the FrontendPluginModule shape)", async () => {
    await build();
    const code = await readFile(frontendJs, "utf8");
    expect(code).toMatch(/activate\s*[:(]/);
    expect(code).toMatch(/registerView/);
  });

  it("passes verify-plugin WITH the directory (the harness's frontend assertions)", async () => {
    // Build FIRST (the sibling tests' beforeEach rm the artifact), then run
    // the harness CLI — the same face a plugin author runs. (plugin-verify
    // depends on this package — importing it here would be a cycle.)
    await build();
    const stdout = execSync("bun packages/plugin-verify/src/cli.ts packages/plugin-scaffold", {
      cwd: join(pkgRoot, "..", ".."),
      stdio: "pipe",
    }).toString();
    expect(stdout).toContain("passes verify-plugin");
  }, 30_000);
});
