import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createJournalSink } from "@dispatch/journal-sink";
import {
  type ConfigAccess,
  createBus,
  createHost,
  createLogger,
  type EventsEmitter,
  type Extension,
  type HostDeps,
  KERNEL_API_VERSION,
  type LogDeps,
  type PermissionGate,
  type ScheduledJob,
  type SecretsAccess,
  type StorageNamespace,
} from "@dispatch/kernel";
import { parseNumberedOpenCodeEnv } from "@dispatch/provider-openai-compat";
import {
  type MemorySample,
  memorySampleAttributes,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { createSqliteStorage } from "@dispatch/storage-sqlite";
import { createBundledExtensions } from "./bundled.js";
import type { ChildHandle } from "./collector-supervisor.js";
import { createCollectorSupervisor } from "./collector-supervisor.js";
import { configMapToAccess, envToConfigMap } from "./config.js";
import { loadExternalExtensions } from "./load-external.js";
import { startMemoryTelemetry } from "./mem-telemetry.js";
import {
  ensurePluginsDir,
  loadPlugin,
  readPluginOverrides,
  scanPlugins,
  toDiscoveredPlugins,
} from "./plugin-discovery.js";
import { reconcilePlugins, resolvePluginsDir } from "./plugin-reconcile.js";

function createEmptySecrets(): SecretsAccess {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
}

function createAllowAllPermissions(): PermissionGate {
  return {
    check: async () => ({ allowed: true }),
  };
}

function createNoopScheduler(): {
  readonly register: (job: ScheduledJob) => void;
  readonly unregister: (jobId: string) => void;
} {
  return { register: () => {}, unregister: () => {} };
}

function createNoopEvents(): EventsEmitter {
  return { emit: () => {} };
}

/** Parse the comma-separated list of external extension module specifiers. */
function parseExternalSpecifiers(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env.DISPATCH_EXTERNAL_EXTENSIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface BootOptions {
  /** Extensions bundled at build time (compiled binary). Merged with any
   * runtime-loaded extensions from `DISPATCH_EXTERNAL_EXTENSIONS` (dev mode). */
  preloadedExtensions?: readonly Extension[];
}

export async function boot(opts: BootOptions = {}): Promise<void> {
  const journalPath = process.env.DISPATCH_JOURNAL ?? "./.dispatch/journal/app.ndjson";
  mkdirSync(dirname(journalPath), { recursive: true });
  const logSink = createJournalSink({ path: journalPath });
  const logDeps: LogDeps = { now: () => Date.now(), newId: () => crypto.randomUUID() };
  const logger = createLogger({ extensionId: "host-bin" }, logSink, logDeps);

  const traceDbPath = process.env.DISPATCH_TRACE_DB ?? "./.dispatch-data/traces.db";

  // Only start the collector supervisor in dev mode (source files available).
  // Compiled binaries don't have the source tree, so the collector can't spawn.
  let supervisor: ReturnType<typeof createCollectorSupervisor> | undefined;
  if (existsSync("packages/observability-collector/src/main.ts")) {
    supervisor = createCollectorSupervisor({
      spawn: (cmd: string[]) => {
        const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
        const handle: ChildHandle = {
          kill: (signal?: string) => proc.kill(signal as NodeJS.Signals),
          exited: proc.exited,
        };
        return handle;
      },
      journalPath,
      dbPath: traceDbPath,
      logger: logger.child({ extensionId: "collector-supervisor" }),
    });
    supervisor.start();
  }

  const dbPath = process.env.DISPATCH_DB ?? "./.dispatch-data/dispatch.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqliteBackend = createSqliteStorage({ path: dbPath });
  const storageFactory = (namespace: string): StorageNamespace => sqliteBackend.storage(namespace);

  const configMap = envToConfigMap(process.env as Readonly<Record<string, string | undefined>>);
  const config: ConfigAccess = configMapToAccess(configMap);

  const deps: HostDeps = {
    logger,
    config,
    storageFactory,
    secrets: createEmptySecrets(),
    permissions: createAllowAllPermissions(),
    scheduler: createNoopScheduler(),
    bus: createBus(logger),
    events: createNoopEvents(),
    logSink,
    logDeps,
  };

  // Load external (out-of-repo) extensions declared via DISPATCH_EXTERNAL_EXTENSIONS.
  const externalSpecifiers = parseExternalSpecifiers(
    process.env as Readonly<Record<string, string | undefined>>,
  );
  const runtimeExtensions = await loadExternalExtensions(externalSpecifiers, logger);
  // Merge build-time bundled extensions (compiled binary) with runtime-loaded
  // ones (dev mode via DISPATCH_EXTERNAL_EXTENSIONS). Dedup by manifest.id.
  const seen = new Set(opts.preloadedExtensions?.map((e) => e.manifest.id) ?? []);
  const externalExtensions = [
    ...(opts.preloadedExtensions ?? []),
    ...runtimeExtensions.filter((e) => !seen.has(e.manifest.id)),
  ];

  // Assemble the credential list. Numbered OpenCode credentials each register a
  // DISTINCT credential (and provider) named `opencode-<N>` → providerId
  // `opencode-<N>`. The old single `opencode` credential and the legacy
  // DISPATCH_API_KEY openai-compat path are gone entirely. A `claude` credential
  // is added when an external Anthropic provider is loaded, and a `codex`
  // credential when an external OpenAI (Codex subscription) provider is loaded.
  const credentials: { name: string; providerId: string }[] = [];

  // Parse numbered OpenCode credentials from the environment (never log values).
  // NOTE: `envToConfigMap` above already ABORTED boot with a secret-free fatal
  // error if any numbered/legacy/obsolete OpenCode variable is invalid — so the
  // environment reached here is guaranteed clean (diagnostics empty). This
  // block only assembles credential names from the validated set.
  const numberedOpenCode = parseNumberedOpenCodeEnv(
    process.env as Readonly<Record<string, string | undefined>>,
    {
      ...(process.env.DISPATCH_BASE_URL !== undefined
        ? { baseURL: process.env.DISPATCH_BASE_URL }
        : {}),
      ...(process.env.DISPATCH_MODEL !== undefined ? { model: process.env.DISPATCH_MODEL } : {}),
    },
  );
  // Defensive invariant: config assembly above refused to boot on diagnostics,
  // so we must never silently boot with a partial/invalid set here.
  if (numberedOpenCode.diagnostics.length > 0) {
    throw new Error(
      "BUG: invalid OpenCode environment reached credential assembly despite config validation",
    );
  }
  for (const entry of numberedOpenCode.credentials) {
    const name = `opencode-${entry.number}`;
    credentials.push({ name, providerId: name });
    logger.info(`Registered numbered credential "${name}" → opencode provider #${entry.number}`);
  }
  if (numberedOpenCode.credentials.length === 0) {
    logger.info(
      "OpenCode provider: no numbered OPENCODE_API_KEY_<n> configured — OpenCode unavailable",
    );
  }

  // The umans credential is always listed (it's the model-catalog index); the
  // provider itself only registers when UMANS_API_KEY is set, so listCatalog
  // gracefully skips it when the provider is absent.
  if (process.env.UMANS_API_KEY) {
    credentials.push({ name: "umans", providerId: "umans" });
    logger.info(`Registered credential "umans" → umans provider`);
  }
  if (process.env.LONGCAT_API_KEY) {
    credentials.push({ name: "longcat", providerId: "longcat" });
    logger.info(`Registered credential "longcat" → longcat provider`);
  }
  if (process.env.HYPER_API_KEY) {
    credentials.push({ name: "hyper", providerId: "hyper" });
    logger.info(`Registered credential "hyper" → hyper provider`);
  }
  if (process.env.OPENROUTER_API_KEY) {
    credentials.push({ name: "openrouter", providerId: "openrouter" });
    logger.info(`Registered credential "openrouter" → openrouter provider`);
  }
  const hasAnthropic = externalExtensions.some((e) =>
    e.manifest.contributes?.providers?.includes("anthropic"),
  );
  if (hasAnthropic) {
    const claudeName = process.env.DISPATCH_CLAUDE_CREDENTIAL ?? "claude";
    credentials.push({ name: claudeName, providerId: "anthropic" });
    logger.info(`Registered credential "${claudeName}" → anthropic provider`);
  }
  const hasOpenAI = externalExtensions.some((e) =>
    e.manifest.contributes?.providers?.includes("openai"),
  );
  if (hasOpenAI) {
    const codexName = process.env.DISPATCH_CODEX_CREDENTIAL ?? "codex";
    credentials.push({ name: codexName, providerId: "openai" });
    logger.info(`Registered credential "${codexName}" → openai provider`);
  }

  // One order-independent bundled set + externally loaded extensions. Ordering
  // is manifest-declared: the host sorts by the dependsOn DAG and gates by
  // apiVersion (see bundled.ts — main.ts curates NOTHING).
  const extensions: Extension[] = [
    ...createBundledExtensions({ credentials }),
    ...externalExtensions,
  ];

  const host = createHost(extensions, deps);
  await host.activate();

  const disabled = host.getDisabled();
  if (disabled.length > 0) {
    for (const d of disabled) {
      logger.warn(`Extension "${d.manifest.id}" disabled: ${d.reason}`);
    }
  }

  // --- Plugin directory drop-ins (plan 04): discover → reconcile → load ----
  //
  // This is the DROP-IN mechanism, complementary to DISPATCH_EXTERNAL_EXTENSIONS
  // above (the explicit env list loaded BEFORE createHost) — both feed the same
  // host: plugins land in the same registries and get the same apiVersion /
  // DAG / capability-gate treatment. Directory plugins get the FULL
  // validatePluginManifest at scan time; env-loaded externals keep the light
  // structural check (trusted, developer-loaded — see load-external.ts).
  //
  // Boot here is READ-ONLY with respect to override records (§4.7): the
  // override-store OWNER (plugin-manager, plan 05) does not exist yet, so we
  // only READ existing records (none until plan 05 lands) and load per the
  // reconcile plan — no record-writing happens in plan 04.
  const pluginLogger = logger.child({ extensionId: "plugin-discovery" });
  const pluginsDir = resolvePluginsDir(
    process.env as Readonly<Record<string, string | undefined>>,
    homedir(),
  );
  try {
    await ensurePluginsDir(pluginsDir);
  } catch {
    // Best effort — an uncreatable root scans as empty (scanPlugins logs it).
  }
  const scan = await scanPlugins(pluginsDir, pluginLogger);
  for (const p of scan.plugins) {
    if (p.status.kind === "invalid") {
      for (const error of p.status.errors) {
        pluginLogger.error(`Plugin at "${p.dir}" is invalid: ${error}`);
      }
    } else if (p.status.kind === "incompatible") {
      pluginLogger.warn(`Plugin "${p.status.manifest.id}" disabled: ${p.status.reason}`);
    }
  }
  const overrides = await readPluginOverrides(host.getHostAPI(), pluginLogger);
  const plan = reconcilePlugins(toDiscoveredPlugins(scan), overrides, {
    kernelApiVersion: KERNEL_API_VERSION,
    loadedIds: host.getExtensions().map((m) => m.id),
    mode: "boot", // default-on at boot (§5) — no disable-record means load
  });
  for (const p of plan.toLoad) {
    const ext = await loadPlugin(p.entryPath, pluginLogger);
    if (ext === undefined) continue; // already logged + skipped by loadPlugin
    const result = await host.loadExtension(ext);
    if (!result.ok) pluginLogger.warn(`Plugin "${p.manifest.id}" disabled: ${result.reason}`);
  }
  for (const d of plan.disabledByOverride) {
    pluginLogger.info(
      `Plugin "${d.manifest.id}" at "${d.dir}" disabled by saved override${d.record.reason ? `: ${d.record.reason}` : ""}`,
    );
  }
  for (const d of plan.disabledWithReason) {
    pluginLogger.warn(`Plugin "${d.manifest.id}" at "${d.dir}" disabled: ${d.reason}`);
  }
  for (const m of plan.missing) {
    // Greyed-out "missing" row (§6): the plugin is gone but its
    // disable-record survives so the user notices; clearing the record is
    // the manager's (plan 05) job.
    pluginLogger.warn(
      `Plugin "${m.id}" is MISSING (directory gone) but has a saved disable-record`,
    );
  }

  // Periodic memory telemetry — leak-localization edge effect (AGENTS.md:
  // timers are edge effects owned by host-bin, the composition root, NOT the
  // kernel). Logs process.memoryUsage() every 15s (the DEFAULT_MEMORY_
  // SAMPLE_INTERVAL_MS in mem-telemetry.ts) tagged with the active-
  // conversation count, and every 5 min runs Bun.gc(true) + logs RSS
  // before/after to distinguish live retained objects from GC fragmentation.
  // The per-turn before/after sampling lives in session-orchestrator; this
  // owns the PERIODIC baseline. All effects are injected (no ambient state);
  // stop() is cleared on shutdown so timers never leak across a restart.
  let memoryTelemetry: { stop: () => void } | undefined;
  let activeConvCountFn: (() => number) | undefined;
  try {
    const orchestrator = host.getHostAPI().getService(sessionOrchestratorHandle);
    activeConvCountFn = () => orchestrator.getActiveConversationCount();
    memoryTelemetry = startMemoryTelemetry({
      logger: logger.child({ extensionId: "mem-telemetry" }),
      sampleMemory: (): MemorySample => {
        const m = process.memoryUsage();
        return {
          rss: m.rss,
          heapUsed: m.heapUsed,
          heapTotal: m.heapTotal,
          external: m.external,
          arrayBuffers: m.arrayBuffers,
        };
      },
      gc: () => Bun.gc(true),
      getActiveConversationCount: () => orchestrator.getActiveConversationCount(),
    });
  } catch (err) {
    logger.error("Memory telemetry not started (session-orchestrator unavailable)", {
      err,
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    memoryTelemetry?.stop();
    logger.info("Shutting down — deactivating extensions");
    await host.deactivate();
    logger.info("Draining collector");
    await supervisor?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const memorySnapshot = () => {
    const m = process.memoryUsage();
    return memorySampleAttributes({
      rss: m.rss,
      heapUsed: m.heapUsed,
      heapTotal: m.heapTotal,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
    });
  };

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", {
      err: reason,
      handler: "unhandledRejection",
      activeConversations: activeConvCountFn?.() ?? "unavailable",
      timestamp: new Date().toISOString(),
      ...memorySnapshot(),
    });
  });

  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", {
      err,
      handler: "uncaughtException",
      activeConversations: activeConvCountFn?.() ?? "unavailable",
      timestamp: new Date().toISOString(),
      ...memorySnapshot(),
    });
    void shutdown();
  });

  logger.info("Dispatch booted");
  console.info("Dispatch booted");
}

// Only auto-boot when this module is the direct entry point (dev mode via
// `bun packages/host-bin/src/main.ts`). When imported by a build wrapper
// (compiled binary), the wrapper calls boot() itself with preloaded extensions.
if (import.meta.main) {
  boot().catch((err) => {
    console.error("Fatal boot error:", err);
    process.exit(1);
  });
}
