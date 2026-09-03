/**
 * The runnable `verify-plugin` face — verify a plugin from the command line:
 *
 *   bun packages/plugin-verify/src/cli.ts <plugin-dir> [--set <dir>]...
 *
 * `<plugin-dir>` is EITHER a directory plugin (`manifest.json` + entry module,
 * the plan-04 drop-in form) OR a workspace package (`src/index.ts` / `index.ts`
 * / `dist/index.js` exporting `extension` — the bundled in-repo form).
 * `--set <dir>` (repeatable) adds a directory's manifest as tier-check context
 * (the set the plugin loads INTO, for the core→standard rule).
 *
 * Exit code 0 = every check passed; 1 = at least one problem (printed, with
 * the check that failed and a specific message each); 2 = usage error. This
 * is the gate a plugin author runs before opening a PR — the same checks the
 * vitest suite enforces in CI (`packages/plugin-verify/src/verify.test.ts`).
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Extension, Manifest } from "@dispatch/kernel";
import { createSurfaceRegistryExtension } from "@dispatch/surface-registry";
import { type VerifyReport, verifyPlugin } from "./verify.js";

const ENTRY_CANDIDATES = ["src/index.ts", "index.ts", "index.js", "dist/index.js"] as const;

/**
 * Load the extension from a plugin directory. Two forms:
 * - directory plugin: `manifest.json` declares the entry (else the
 *   conventional `index.ts`/`index.js`/`dist/index.js`), and the module's
 *   `extension` export is the extension;
 * - workspace package: no manifest.json — the entry's `extension` export
 *   carries the manifest in code.
 */
async function loadExtensionFromDir(dir: string): Promise<Extension> {
  const hasManifest = await stat(join(dir, "manifest.json")).then(
    () => true,
    () => false,
  );
  let parsed: { entry?: string } | undefined;
  if (hasManifest) {
    try {
      parsed = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
        entry?: string;
      };
    } catch (err) {
      throw new Error(`manifest.json at "${dir}" is not valid JSON: ${String(err)}`);
    }
  }

  const candidates = parsed?.entry !== undefined ? [parsed.entry] : [...ENTRY_CANDIDATES];
  let entryPath: string | undefined;
  for (const candidate of candidates) {
    const full = join(dir, candidate);
    const exists = await stat(full).then(
      () => true,
      () => false,
    );
    if (exists) {
      // Absolute path — a bare relative specifier in a dynamic import() would
      // resolve from THIS module's location, not the caller's cwd.
      entryPath = resolve(full);
      break;
    }
  }
  if (entryPath === undefined) {
    throw new Error(
      `cannot resolve the entry for plugin at "${dir}" — set manifest.entry or provide one of: ${ENTRY_CANDIDATES.join(", ")}`,
    );
  }

  const module = (await import(entryPath)) as { extension?: Extension; default?: Extension };
  const ext = module.extension ?? module.default;
  if (ext === undefined || typeof ext !== "object" || !("manifest" in ext)) {
    throw new Error(
      `the entry at "${entryPath}" has no \`extension\` export — export \`extension: Extension\` (see packages/plugin-scaffold)`,
    );
  }
  return ext;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const setDirs: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--set") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("usage error: --set requires a directory argument");
        return 2;
      }
      setDirs.push(value);
      i += 1;
      continue;
    }
    rest.push(arg);
  }
  const target = rest[0];
  if (target === undefined) {
    console.error("usage: bun packages/plugin-verify/src/cli.ts <plugin-dir> [--set <dir>]...");
    return 2;
  }

  let ext: Extension;
  try {
    ext = await loadExtensionFromDir(target);
  } catch (err) {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let setManifests: Manifest[] = [];
  let environment: Extension[] | undefined;
  try {
    const setExts = await Promise.all(setDirs.map(loadExtensionFromDir));
    setManifests = setExts.map((e) => e.manifest);
    // The --set dirs are the plugin's LOAD SET — they belong to the disposal
    // environment too (its dependsOn targets live there). The surface
    // registry is the default environment; keep it alongside.
    if (setExts.length > 0) {
      environment = [createSurfaceRegistryExtension(), ...setExts];
    }
  } catch (err) {
    console.error(
      `FAIL: cannot read --set context: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  const report: VerifyReport = await verifyPlugin(ext, {
    setManifests,
    ...(environment !== undefined ? { environment } : {}),
  });
  if (report.ok) {
    console.log(`OK: plugin "${report.pluginId}" passes verify-plugin`);
    return 0;
  }
  console.error(`FAIL: plugin "${report.pluginId}" failed verify-plugin:`);
  for (const problem of report.problems) {
    console.error(`  [${problem.check}] ${problem.message}`);
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("verify-plugin crashed:", err);
    process.exit(2);
  });
