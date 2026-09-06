/**
 * verifyPlugin — the composite verify-plugin harness entry (plan 08 §8.3).
 *
 * Runs every check over one plugin and returns a single report:
 * - `manifest` — completeness + tier/trust/apiVersion validity (the plan-04
 *   mirror, `checks.ts`),
 * - `tier-deps` — the constitutional core→standard rule over the plugin
 *   together with the set it loads into (`checks.ts`),
 * - `disposal` — load/unload/reload in a test host with ZERO dangling
 *   registrations AND zero leaked surfaces (`disposal.ts`).
 *
 * `verifyPlugin` NEVER throws — a wrong plugin is a REPORT with specific,
 * human-readable problems, so a test (or the CLI) fails LOUDLY at test time
 * with the full list instead of silently at boot (§10.3).
 */

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Extension, Manifest } from "@dispatch/kernel";
import { type CheckResult, checkManifest, checkTierDeps } from "./checks.js";
import { type VerifyDisposalOpts, verifyDisposal } from "./disposal.js";

/** One failed check, attributed. */
export interface VerifyProblem {
  /** Which check failed: "manifest" | "tier-deps" | "disposal" | "frontend". */
  readonly check: "manifest" | "tier-deps" | "disposal" | "frontend";
  /** The specific, human-readable failure message. */
  readonly message: string;
}

/** The full verification report for one plugin. */
export interface VerifyReport {
  readonly pluginId: string;
  /** True iff every check passed. */
  readonly ok: boolean;
  readonly problems: readonly VerifyProblem[];
}

export interface VerifyPluginOpts extends VerifyDisposalOpts {
  /**
   * The manifests of the set the plugin loads INTO (e.g. the bundled set) —
   * the context for the core→standard tier check. Optional; the tier rule is
   * intra-set, so a plugin alone is checked for self-edges only.
   */
  readonly setManifests?: readonly Manifest[];
  /** Skip the test-host disposal round-trip (manifest + tier checks only). */
  readonly skipDisposal?: boolean;
  /**
   * The plugin's DIRECTORY (plan 03) — enables the frontend checks: a
   * manifest declaring `frontend` must have its `entry` file RESOLVABLE
   * inside the directory (traversal-safe). The CLI passes the target dir.
   */
  readonly pluginDir?: string;
}

function toProblems(check: VerifyProblem["check"], result: CheckResult): VerifyProblem[] {
  return result.errors.map((message) => ({ check, message }));
}

/**
 * The frontend-entry checks (plan 03) — the I/O half of the harness's
 * frontend assertions (the range grammar is checked purely in
 * `checkManifest`). `undefined` problems = nothing to report.
 */
async function checkFrontendEntry(
  manifest: Manifest,
  pluginDir: string | undefined,
): Promise<VerifyProblem[]> {
  if (manifest.frontend === undefined) return [];
  if (pluginDir === undefined) {
    return [
      {
        check: "frontend",
        message:
          'the manifest declares "frontend" but no plugin directory was given — pass pluginDir (the CLI does) so the entry can be resolved',
      },
    ];
  }
  const entry = manifest.frontend.entry;
  const entryPath = resolve(pluginDir, entry);
  const rel = relative(pluginDir, entryPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return [
      {
        check: "frontend",
        message: `"frontend.entry" ("${entry}") escapes the plugin directory — a traversal entry is an authoring error (the host refuses it)`,
      },
    ];
  }
  try {
    const s = await stat(entryPath);
    if (!s.isFile()) {
      return [
        {
          check: "frontend",
          message: `"frontend.entry" ("${entry}") is not a file (resolved ${entryPath}) — build it with the scaffold's \`build:frontend\``,
        },
      ];
    }
  } catch {
    return [
      {
        check: "frontend",
        message: `"frontend.entry" ("${entry}") does not exist (expected ${entryPath}) — build it with the scaffold's \`build:frontend\` before shipping`,
      },
    ];
  }
  return [];
}

/**
 * Verify one plugin. Pass `skipDisposal: true` for a manifest-only check
 * (the disposal round-trip needs the plugin's environment to be loadable).
 */
export async function verifyPlugin(
  ext: Extension,
  opts: VerifyPluginOpts = {},
): Promise<VerifyReport> {
  const problems: VerifyProblem[] = [];

  // 1. Manifest completeness / validity. Checks the manifest object itself —
  //    for a directory plugin the CLI passes the PARSED manifest.json, so the
  //    same check covers the JSON-authored path.
  const manifest = checkManifest(ext.manifest);
  problems.push(...toProblems("manifest", manifest));

  // 2. Tier rule: core depends only on core (AGENTS.md) — over the plugin
  //    plus the set it will load into.
  const tiers = checkTierDeps(ext.manifest, opts.setManifests ?? []);
  problems.push(...toProblems("tier-deps", tiers));

  // 3. Frontend entry (plan 03): a manifest declaring `frontend` must have a
  //    resolvable entry inside the plugin directory (when the dir is known).
  problems.push(...(await checkFrontendEntry(ext.manifest, opts.pluginDir)));

  // 4. Disposal contract + surface leak, in a throwaway test host.
  if (opts.skipDisposal !== true) {
    const disposal = await verifyDisposal(ext, opts);
    problems.push(...toProblems("disposal", disposal));
  }

  return {
    pluginId: ext.manifest.id,
    ok: problems.length === 0,
    problems,
  };
}
