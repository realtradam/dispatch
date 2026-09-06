/**
 * Plugin discovery & loading — the FILESYSTEM EDGE of plan 04 (packaging,
 * discovery & override persistence).
 *
 * All I/O lives here: `scanPlugins` reads directories + manifest.json files
 * (manifest-FIRST — it never imports plugin code), and `loadPlugin` performs
 * the cache-busted dynamic import. The DECISIONS (validation, reconciliation)
 * are pure and live in `plugin-reconcile.ts`; the boot wiring that applies
 * the reconcile plan lives in `main.ts`.
 *
 * A plugin is a directory with `manifest.json` + code (§4.1):
 *
 *   <plugins-root>/<plugin-id>/
 *   ├── manifest.json     # required — parsed WITHOUT importing code
 *   └── index.ts | index.js | <manifest.entry>   # code entry
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import {
  type Extension,
  type HostAPI,
  isApiVersionCompatible,
  KERNEL_API_VERSION,
  type Logger,
  type Manifest,
} from "@dispatch/kernel";
import type { ReconciledScanBuckets, ScannedPluginEntry } from "@dispatch/plugin-manager";
import { isExtension } from "./load-external.js";
import {
  type DiscoveredPlugin,
  decodeOverrideRecord,
  PLUGIN_OVERRIDES_NAMESPACE,
  type PluginOverrideRecord,
  type ReconcilePlan,
  validatePluginManifest,
} from "./plugin-reconcile.js";

// --- Scan (§4.3 — pure discovery + validation, loads NOTHING) ---

/** Per-plugin scan outcome. */
export type ScanStatus =
  /** Valid manifest, apiVersion-compatible, code entry resolvable. */
  | { readonly kind: "loadable"; readonly manifest: Manifest; readonly entryPath: string }
  /** Manifest missing / unparsable / failing validation — the errors say why. */
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  /** Valid manifest whose apiVersion is incompatible with the running kernel. */
  | { readonly kind: "incompatible"; readonly manifest: Manifest; readonly reason: string };

export interface ScannedPlugin {
  /** Absolute plugin directory. */
  readonly dir: string;
  readonly status: ScanStatus;
}

export interface ScanResult {
  /** The (absolute) root that was scanned. */
  readonly root: string;
  readonly plugins: readonly ScannedPlugin[];
}

/** Conventional entry filenames tried (in order) when the manifest sets no `entry`. */
const CONVENTIONAL_ENTRIES: readonly string[] = ["index.ts", "index.js"];

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

interface EntryResolution {
  readonly entryPath?: string;
  readonly error?: string;
}

/**
 * Resolve a plugin's code entry: the manifest's `entry` (relative to the
 * plugin dir) if set, else the conventional `index.ts`/`index.js`. The
 * resolved path must stay INSIDE the plugin directory (a `../`-escaping
 * entry is an authoring error, not a feature).
 */
async function resolveEntryPath(dir: string, manifest: Manifest): Promise<EntryResolution> {
  if (manifest.entry !== undefined) {
    const entryPath = path.resolve(dir, manifest.entry);
    const rel = path.relative(dir, entryPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `"entry" ("${manifest.entry}") escapes the plugin directory` };
    }
    if (!(await isFile(entryPath))) {
      return { error: `"entry" file not found: ${entryPath}` };
    }
    return { entryPath };
  }
  for (const name of CONVENTIONAL_ENTRIES) {
    const entryPath = path.join(dir, name);
    if (await isFile(entryPath)) return { entryPath };
  }
  return {
    error: `no code entry found in ${dir} (expected ${CONVENTIONAL_ENTRIES.join(" or ")}, or set "entry" in manifest.json)`,
  };
}

/**
 * Scan a plugins root: list every subdirectory, parse + validate its
 * `manifest.json`, and classify it — WITHOUT importing any code (§4.1
 * manifest-first). Safe to run any time; loading is a separate explicit
 * step (plan 05's manager API calls scan, then loads per consent).
 *
 * Fault isolation: an unreadable ROOT scans as empty (the dir may not exist
 * yet — no plugins installed); per-plugin problems surface as `invalid`
 * statuses with the reason, never as thrown errors.
 */
export async function scanPlugins(pluginsDir: string, logger: Logger): Promise<ScanResult> {
  const root = path.resolve(pluginsDir);
  const plugins: ScannedPlugin[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    logger.debug(`Plugins root "${root}" unreadable — scanning as empty`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return { root, plugins };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Dot-dirs are noise (`.git`, editor droppings), not plugins.
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);

    let raw: string;
    try {
      raw = await readFile(path.join(dir, "manifest.json"), "utf8");
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const why =
        code === "ENOENT"
          ? "manifest.json not found"
          : `manifest.json unreadable: ${err instanceof Error ? err.message : String(err)}`;
      plugins.push({ dir, status: { kind: "invalid", errors: [why] } });
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      plugins.push({
        dir,
        status: {
          kind: "invalid",
          errors: [
            `manifest.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          ],
        },
      });
      continue;
    }

    const validation = validatePluginManifest(json, { dirName: entry.name });
    if (!validation.ok) {
      plugins.push({ dir, status: { kind: "invalid", errors: validation.errors } });
      continue;
    }
    // §4.1 decision: trust manifest.id, warn on a dir-name mismatch.
    for (const warning of validation.warnings) {
      logger.warn(`Plugin at "${dir}": ${warning}`);
    }
    const manifest = validation.manifest;

    if (!isApiVersionCompatible(manifest.apiVersion, KERNEL_API_VERSION)) {
      plugins.push({
        dir,
        status: {
          kind: "incompatible",
          manifest,
          reason: `apiVersion "${manifest.apiVersion}" is incompatible with kernel API ${KERNEL_API_VERSION}`,
        },
      });
      continue;
    }

    const entryResolution = await resolveEntryPath(dir, manifest);
    if (entryResolution.entryPath === undefined) {
      plugins.push({
        dir,
        status: { kind: "invalid", errors: [entryResolution.error ?? "no code entry resolved"] },
      });
      continue;
    }

    plugins.push({
      dir,
      status: { kind: "loadable", manifest, entryPath: entryResolution.entryPath },
    });
  }

  return { root, plugins };
}

/** Extract the loadable plugins from a scan, as `DiscoveredPlugin`s for `reconcilePlugins`. */
export function toDiscoveredPlugins(scan: ScanResult): DiscoveredPlugin[] {
  const discovered: DiscoveredPlugin[] = [];
  for (const p of scan.plugins) {
    if (p.status.kind === "loadable") {
      discovered.push({ dir: p.dir, manifest: p.status.manifest, entryPath: p.status.entryPath });
    }
  }
  return discovered;
}

// --- Loading (§4.4 — cache-busted import) ---

/**
 * Import a plugin's entry with a CACHE-BUSTING query — `?v=<mtimeMs>` (§9):
 * without it, updates silently load stale code.
 *
 * **Spike result (plan 04, verified against dev Bun AND a real
 * `bun build --compile` binary):** Bun keys its module cache by the FULL
 * specifier including the query string — the same `?v=` twice returns the
 * cached instance, a changed `?v=` (e.g. after an mtime-bumping edit)
 * returns a fresh module instance, and the compiled binary transpiles the
 * imported `.ts` source at runtime (so plugins may ship as TS source in
 * production too). ONE constraint: the specifier must be an ABSOLUTE path —
 * relative specifiers resolve against the binary's internal `/$bunfs/root/`.
 * `scanPlugins` produces absolute paths; `path.resolve` enforces it here.
 *
 * Fault isolation (§4.4): a broken plugin (import error, no valid extension
 * export) is logged + SKIPPED — it never crashes boot. The structural check
 * is the same `isExtension` the env-loaded external path uses; the host's
 * plan-01 `loadExtension` then applies apiVersion gating, dependency
 * ordering, and activation fault isolation.
 */
export async function loadPlugin(
  entryPath: string,
  logger: Logger,
): Promise<Extension | undefined> {
  const abs = path.resolve(entryPath);
  try {
    const mtimeMs = (await stat(abs)).mtimeMs;
    const specifier = `${abs}?v=${mtimeMs}`;
    const mod = (await import(specifier)) as Record<string, unknown>;
    const candidate = mod.extension ?? mod.default ?? mod;
    if (isExtension(candidate)) {
      logger.info(`Loaded plugin "${candidate.manifest.id}" from ${abs}`);
      return candidate;
    }
    logger.warn(`Plugin entry "${abs}" has no valid extension export; skipped`);
    return undefined;
  } catch (err) {
    logger.error(`Failed to load plugin "${abs}"; skipped`, { err });
    return undefined;
  }
}

/**
 * Ensure the plugins root exists (boot-time convenience so the default XDG
 * location is created on first boot — user-writable, zero sudo).
 */
export async function ensurePluginsDir(pluginsDir: string): Promise<string> {
  const root = path.resolve(pluginsDir);
  await mkdir(root, { recursive: true });
  return root;
}

// --- Override records (§4.5 — READ-ONLY in plan 04) ---

/**
 * Read the persisted override records from the namespaced KV store.
 *
 * **Plan 04 boot is READ-ONLY with respect to override records (§4.7):** the
 * override-store OWNER (the plugin-manager core extension) does not exist
 * until plan 05 — this reader only surfaces already-persisted records
 * (there will be none until plan 05 lands) so the reconcile plan can honor
 * them. It deliberately does NOT write. Record-writing arrives with plan 05.
 *
 * Fault-isolated: an unavailable or empty store yields no records (boot
 * proceeds; everything compatible loads — the §6 default).
 */
export async function readPluginOverrides(
  hostApi: HostAPI,
  logger: Logger,
): Promise<Map<string, PluginOverrideRecord>> {
  const overrides = new Map<string, PluginOverrideRecord>();
  try {
    const ns = hostApi.storage(PLUGIN_OVERRIDES_NAMESPACE);
    for (const key of await ns.keys()) {
      const raw = await ns.get(key);
      if (raw === null) continue;
      const record = decodeOverrideRecord(raw);
      if (record !== undefined) {
        overrides.set(key, record);
      } else {
        logger.warn(`plugin-overrides: ignoring unparsable record for "${key}"`);
      }
    }
  } catch (err) {
    logger.warn(
      `plugin-overrides store unavailable — reconciling with no override records: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return overrides;
}

// ── Plugin-manager view adapters (plan 05) ──────────────────────────────────

/**
 * Flatten a scan into the manager's kernel-typed entries — the adapter the
 * composition root hands to the plugin-manager's `PluginEngine`
 * (`scanPluginsDir`). Pure mapping; the manager never imports host-bin.
 */
export function toScannedEntries(scan: ScanResult): ScannedPluginEntry[] {
  const entries: ScannedPluginEntry[] = [];
  for (const p of scan.plugins) {
    switch (p.status.kind) {
      case "loadable":
        entries.push({
          dir: p.dir,
          kind: "loadable",
          manifest: p.status.manifest,
          entryPath: p.status.entryPath,
        });
        break;
      case "invalid":
        entries.push({ dir: p.dir, kind: "invalid", errors: p.status.errors });
        break;
      case "incompatible":
        entries.push({
          dir: p.dir,
          kind: "incompatible",
          manifest: p.status.manifest,
          reason: p.status.reason,
        });
        break;
    }
  }
  return entries;
}

/**
 * Flatten a `mode: "scan"` reconcile plan into the manager's buckets — the
 * other half of the `PluginEngine.scanPluginsDir` adapter. Pure mapping.
 */
export function toReconciledBuckets(plan: ReconcilePlan): ReconciledScanBuckets {
  return {
    unchecked: plan.unchecked.map((p) => ({ dir: p.dir, manifest: p.manifest })),
    alreadyLoaded: plan.alreadyLoaded.map((p) => ({ dir: p.dir, manifest: p.manifest })),
    disabledByOverride: plan.disabledByOverride.map((d) => ({
      dir: d.dir,
      manifest: d.manifest,
      record: d.record,
    })),
    disabledWithReason: plan.disabledWithReason.map((d) => ({
      dir: d.dir,
      manifest: d.manifest,
      reason: d.reason,
    })),
    missing: plan.missing.map((m) => ({ id: m.id, record: m.record })),
  };
}
