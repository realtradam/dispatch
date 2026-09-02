/**
 * Plugin reconciliation, manifest validation, and discovery-root resolution —
 * the PURE decision logic of plan 04 (packaging, discovery & override
 * persistence).
 *
 * No I/O lives here: filesystem effects (readdir / readFile / import) live in
 * `plugin-discovery.ts`, and the boot wiring that APPLIES a `ReconcilePlan`
 * lives in `main.ts`. Every export is input→output and unit-test dense
 * (AGENTS.md: effects live at the edges, injected).
 *
 * Vocabulary (GLOSSARY.md): "plugin" is the directory-packaged form of an
 * extension — every plugin loads through the same host lifecycle as bundled
 * extensions.
 */

import {
  isApiVersionCompatible,
  type Manifest,
  resolveActivationOrderSafe,
} from "@dispatch/kernel";

// --- Override records (§6: the DB records overrides/disables, not full state) ---

export type { PluginOverrideKind, PluginOverrideRecord } from "@dispatch/plugin-manager";
/**
 * The override-record contract is CANONICAL in `@dispatch/plugin-manager`
 * (the override-store OWNER — plan 05's manager writes; this module's boot
 * path only reads). Re-exported here so the plan-04 reader and the plan-05
 * writer cannot drift and this module's public surface is unchanged.
 */
export {
  decodeOverrideRecord,
  encodeOverrideRecord,
  PLUGIN_OVERRIDES_NAMESPACE,
} from "@dispatch/plugin-manager";

import type { PluginOverrideRecord } from "@dispatch/plugin-manager";

// --- Discovery root resolution (§4.2) ---

/**
 * Resolve the plugins directory. Pure: `env` and `homeDir` are injected (the
 * caller reads `process.env` / `os.homedir()`), so this is trivially
 * testable and free of I/O.
 *
 * Precedence: `DISPATCH_PLUGINS_DIR` (parity with the other env-based config
 * in `envToConfigMap`) → `$XDG_DATA_HOME/dispatch/plugins` →
 * `~/.local/share/dispatch/plugins` (XDG data home, user-writable, zero
 * sudo). Empty-string env values are treated as unset.
 */
export function resolvePluginsDir(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string {
  const override = env.DISPATCH_PLUGINS_DIR?.trim();
  if (override !== undefined && override.length > 0) return override;
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg !== undefined && xdg.length > 0 ? xdg : `${homeDir}/.local/share`;
  return `${base}/dispatch/plugins`;
}

// --- Manifest validation (§4.1 — manifest-first, fail loudly at scan time) ---

/** Outcome of `validatePluginManifest`. */
export type PluginManifestValidation =
  | { readonly ok: true; readonly manifest: Manifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

const VALID_TIERS: readonly string[] = ["core", "providers", "standard"];
const VALID_TRUST: readonly string[] = ["bundled", "local", "external"];

/** The known `contributes` keys — array-of-strings fields. */
const CONTRIBUTION_KEYS: readonly string[] = [
  "tools",
  "providers",
  "auth",
  "hooks",
  "routes",
  "commands",
  "services",
  "migrations",
  "scheduledJobs",
  "settings",
];

/** The known `capabilities` keys — boolean fields. */
const CAPABILITY_KEYS: readonly string[] = ["fs", "shell", "network", "secrets", "db", "spawn"];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
}

/**
 * Validate a parsed `manifest.json` — the runtime mirror of the `Manifest`
 * TS contract, so an invalid plugin fails LOUDLY at scan time instead of
 * silently at boot (§4.1). Pure: takes the already-JSON-parsed value.
 *
 * Checks format and field completeness (required set: id, name, version,
 * apiVersion, tier, trust — post-plan-02); apiVersion COMPATIBILITY with the
 * kernel is deliberately NOT checked here (it needs the kernel version and
 * is reported as its own scan status / reconcile row, not a validation
 * error).
 *
 * `opts.dirName` (the directory the manifest was found in) enables the
 * dir-name/id mismatch WARNING — the decision from §4.1 is to trust
 * `manifest.id` and only warn.
 *
 * Validation asymmetry (§4.1, on record): plugins discovered via the
 * directory scan get THIS full validation; `DISPATCH_EXTERNAL_EXTENSIONS`
 * env-loaded plugins get only the `isExtension` structural check in
 * `load-external.ts` (plus a tier warning) — they are trusted,
 * developer-loaded modules, not user drop-ins.
 */
export function validatePluginManifest(
  json: unknown,
  opts?: { readonly dirName?: string },
): PluginManifestValidation {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, errors: ["manifest.json must be a JSON object"] };
  }
  const raw = json as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields (§10.4 required set).
  for (const field of ["id", "name", "version", "apiVersion"] as const) {
    if (!isNonEmptyString(raw[field])) errors.push(`missing or invalid required field "${field}"`);
  }
  if (!VALID_TIERS.includes(raw.tier as string)) {
    errors.push(
      `missing or invalid required field "tier" — expected one of ${VALID_TIERS.map((t) => `"${t}"`).join(", ")}`,
    );
  }
  if (!VALID_TRUST.includes(raw.trust as string)) {
    errors.push(
      `missing or invalid required field "trust" — expected one of ${VALID_TRUST.map((t) => `"${t}"`).join(", ")}`,
    );
  }

  // apiVersion must be a PARSEABLE range (compatibility vs the kernel is a
  // separate status — see reconcilePlugins / scanPlugins).
  if (isNonEmptyString(raw.apiVersion)) {
    try {
      isApiVersionCompatible(raw.apiVersion, "0.0.0");
    } catch {
      errors.push(`invalid apiVersion range "${raw.apiVersion}"`);
    }
  }

  // Optional fields, when present, must have the contract's shape.
  if (raw.dependsOn !== undefined && !isStringArray(raw.dependsOn)) {
    errors.push('"dependsOn" must be an array of non-empty strings');
  }
  if (raw.entry !== undefined && !isNonEmptyString(raw.entry)) {
    errors.push('"entry" must be a non-empty string (relative to the plugin directory)');
  }
  if (raw.activation !== undefined && typeof raw.activation !== "string") {
    errors.push('"activation" must be a string');
  }
  if (raw.contributes !== undefined) {
    if (!raw.contributes || typeof raw.contributes !== "object" || Array.isArray(raw.contributes)) {
      errors.push('"contributes" must be an object');
    } else {
      const contributes = raw.contributes as Record<string, unknown>;
      for (const key of CONTRIBUTION_KEYS) {
        if (contributes[key] !== undefined && !isStringArray(contributes[key])) {
          errors.push(`"contributes.${key}" must be an array of strings`);
        }
      }
      // Runtime/external plugins CANNOT contribute migrations (§4.1): the
      // host collects migrations when createHost() builds the bundled set —
      // BEFORE any runtime load — so a runtime plugin's migrations would be
      // silently ignored. Fail loudly instead of dropping them.
      if (contributes.migrations !== undefined) {
        errors.push(
          "runtime plugins cannot contribute migrations (the host collects migrations at createHost() time, before any runtime load)",
        );
      }
    }
  }
  if (raw.capabilities !== undefined) {
    if (
      !raw.capabilities ||
      typeof raw.capabilities !== "object" ||
      Array.isArray(raw.capabilities)
    ) {
      errors.push('"capabilities" must be an object');
    } else {
      const capabilities = raw.capabilities as Record<string, unknown>;
      for (const key of CAPABILITY_KEYS) {
        if (capabilities[key] !== undefined && typeof capabilities[key] !== "boolean") {
          errors.push(`"capabilities.${key}" must be a boolean`);
        }
      }
    }
  }
  if (raw.frontend !== undefined) {
    if (!raw.frontend || typeof raw.frontend !== "object" || Array.isArray(raw.frontend)) {
      errors.push('"frontend" must be an object with "apiVersion" and "entry"');
    } else {
      const frontend = raw.frontend as Record<string, unknown>;
      if (!isNonEmptyString(frontend.apiVersion)) {
        errors.push('"frontend.apiVersion" must be a non-empty string');
      }
      if (!isNonEmptyString(frontend.entry)) {
        errors.push('"frontend.entry" must be a non-empty string');
      }
    }
  }

  if (errors.length === 0) {
    // Directory name should equal manifest.id (§4.1 decision: trust
    // manifest.id, warn on mismatch — it is almost certainly an authoring
    // error).
    if (opts?.dirName !== undefined && opts.dirName !== raw.id) {
      warnings.push(
        `directory name "${opts.dirName}" does not match manifest id "${raw.id}" — trusting manifest.id`,
      );
    }
    return { ok: true, manifest: raw as unknown as Manifest, warnings };
  }
  return { ok: false, errors };
}

// --- Boot reconciliation (§4.6 — pure decision logic) ---

/** A plugin discovered by the directory scan, ready to load. */
export interface DiscoveredPlugin {
  /** Absolute plugin directory. */
  readonly dir: string;
  /** The validated manifest (from manifest.json). */
  readonly manifest: Manifest;
  /** Absolute entry file path (resolved by the scan). */
  readonly entryPath: string;
}

/** A discovered plugin refused at reconcile time (disabled-with-reason grammar). */
export interface ReconcileDisabled {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly reason: string;
}

/** An override record whose plugin dir is gone — a greyed-out "missing" row. */
export interface ReconcileMissing {
  readonly id: string;
  readonly record: PluginOverrideRecord;
}

/**
 * The plan: what boot (or a mid-session scan) should do per discovered
 * plugin. Pure input→output — the caller applies it.
 */
export interface ReconcilePlan {
  /**
   * Load these, in dependency-safe order (BOOT mode: present + compatible +
   * no disable-record → load, default-on per §5).
   */
  readonly toLoad: readonly DiscoveredPlugin[];
  /**
   * SCAN mode only: NEW discoveries (no override record, not loaded) listed
   * UNCHECKED — the checkbox is the consent gate (§5).
   */
  readonly unchecked: readonly DiscoveredPlugin[];
  /** SCAN mode bookkeeping: discovered ids that are already live. */
  readonly alreadyLoaded: readonly DiscoveredPlugin[];
  /** Present but disabled by an override record — leave unloaded, show disabled. */
  readonly disabledByOverride: readonly {
    readonly dir: string;
    readonly manifest: Manifest;
    readonly record: PluginOverrideRecord;
  }[];
  /**
   * Present but refused: apiVersion-incompatible, unmet dependencies,
   * duplicate ids, or an id colliding with a loaded extension — the
   * disabled-with-reason grammar the host already uses.
   */
  readonly disabledWithReason: readonly ReconcileDisabled[];
  /** Override records whose plugin dir is GONE — greyed-out "missing" rows (§6). */
  readonly missing: readonly ReconcileMissing[];
}

export interface ReconcileOpts {
  readonly kernelApiVersion: string;
  /** Ids of currently-loaded extensions (bundled set + activated plugins). */
  readonly loadedIds: readonly string[];
  /**
   * `"boot"`: new discoveries load by default (§5 default-on at boot).
   * `"scan"`: new discoveries are listed UNCHECKED (consent gate).
   */
  readonly mode: "boot" | "scan";
}

/** Host-uniform reason for unmet dependencies (mirrors the host's grammar). */
function formatUnmetDeps(id: string, missing: readonly string[]): string {
  const list = missing.map((d) => `"${d}"`).join(", ");
  const verb = missing.length === 1 ? "is" : "are";
  return `Extension "${id}" depends on ${list}, which ${verb} not loaded`;
}

/**
 * Reconcile discovered plugins against the persisted override records
 * (§4.6 / §6). Pure: `discovered` comes from the scan, `overrides` from the
 * KV store, and the caller supplies the kernel API version + the ids that
 * are already loaded + the mode. Unit-test dense — every §6 rule is a test.
 *
 * Dependency handling mirrors the plan-01 non-throwing DAG mode: a candidate
 * whose dependency is neither loaded nor among the loadable candidates is
 * refused into `disabledWithReason` ("depends on X, which is not loaded"),
 * never thrown. `toLoad` comes back dependency-safe (dependencies first).
 */
export function reconcilePlugins(
  discovered: readonly DiscoveredPlugin[],
  overrides: ReadonlyMap<string, PluginOverrideRecord>,
  opts: ReconcileOpts,
): ReconcilePlan {
  const loaded = new Set<string>(opts.loadedIds);

  // "Missing" rows: override records whose plugin dir is gone (§6 — so the
  // user notices; clearing the record is plan 05's writer's job).
  const discoveredIds = new Set<string>();
  for (const p of discovered) {
    if (!discoveredIds.has(p.manifest.id)) discoveredIds.add(p.manifest.id);
  }
  const missing: ReconcileMissing[] = [];
  for (const [id, record] of overrides) {
    if (!discoveredIds.has(id)) missing.push({ id, record });
  }

  const toLoad: DiscoveredPlugin[] = [];
  const unchecked: DiscoveredPlugin[] = [];
  const alreadyLoaded: DiscoveredPlugin[] = [];
  const disabledByOverride: {
    dir: string;
    manifest: Manifest;
    record: PluginOverrideRecord;
  }[] = [];
  const disabledWithReason: ReconcileDisabled[] = [];

  // Dedupe by manifest id (two dirs claiming one id is an authoring error —
  // first directory wins, later ones are refused loudly). Mirrors
  // resolveActivationOrderSafe's tolerance of duplicate ids.
  const seenIds = new Set<string>();
  for (const p of discovered) {
    const id = p.manifest.id;
    if (seenIds.has(id)) {
      disabledWithReason.push({
        dir: p.dir,
        manifest: p.manifest,
        reason: `duplicate plugin id "${id}" — the first directory declaring it wins`,
      });
      continue;
    }
    seenIds.add(id);

    if (loaded.has(id)) {
      if (opts.mode === "scan") {
        alreadyLoaded.push(p);
      } else {
        disabledWithReason.push({
          dir: p.dir,
          manifest: p.manifest,
          reason: `Extension "${id}" is already loaded`,
        });
      }
      continue;
    }

    if (!isApiVersionCompatible(p.manifest.apiVersion, opts.kernelApiVersion)) {
      disabledWithReason.push({
        dir: p.dir,
        manifest: p.manifest,
        reason: `apiVersion "${p.manifest.apiVersion}" is incompatible with kernel API ${opts.kernelApiVersion}`,
      });
      continue;
    }

    const record = overrides.get(id);
    if (record?.disabled) {
      disabledByOverride.push({ dir: p.dir, manifest: p.manifest, record });
      continue;
    }

    // Candidate for load (boot) / unchecked listing (scan).
    if (opts.mode === "scan") {
      unchecked.push(p);
    } else {
      toLoad.push(p);
    }
  }

  // Dependency resolution over the loadable candidates (boot mode) — the
  // plan-01 non-throwing DAG mode via the kernel's `resolveActivationOrderSafe`:
  // unmet deps are refused with a reason, and the survivors come back
  // dependency-safe (dependencies first). In scan mode nothing loads, but an
  // unmet dep is still surfaced so the manager UI can say what would happen
  // on enable.
  const candidates = opts.mode === "boot" ? toLoad : unchecked;
  const resolution = resolveActivationOrderSafe(
    candidates.map((p) => p.manifest),
    { satisfied: [...opts.loadedIds] },
  );
  const byId = new Map(candidates.map((p) => [p.manifest.id, p]));
  const orderedCandidates: DiscoveredPlugin[] = [];
  for (const m of resolution.ordered) {
    const p = byId.get(m.id);
    if (p !== undefined) orderedCandidates.push(p);
  }
  for (const unmet of resolution.unmet) {
    const p = byId.get(unmet.manifest.id);
    if (p === undefined) continue;
    disabledWithReason.push({
      dir: p.dir,
      manifest: p.manifest,
      reason: formatUnmetDeps(p.manifest.id, unmet.missing),
    });
  }

  return {
    toLoad: opts.mode === "boot" ? orderedCandidates : [],
    unchecked: opts.mode === "scan" ? orderedCandidates : [],
    alreadyLoaded,
    disabledByOverride,
    disabledWithReason,
    missing,
  };
}
