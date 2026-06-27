import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { extension as authApikeyExt } from "@dispatch/auth-apikey";
import { extension as cacheWarmingExt } from "@dispatch/cache-warming";
import { extension as conversationStoreExt } from "@dispatch/conversation-store";
import { createCredentialStoreExtension } from "@dispatch/credential-store";
import { createExecBackendExtension } from "@dispatch/exec-backend";
import { extension as heartbeatExt } from "@dispatch/heartbeat";
import { createJournalSink } from "@dispatch/journal-sink";
import {
  type ConfigAccess,
  createBus,
  createHost,
  createLogger,
  type EventsEmitter,
  type Extension,
  type HostDeps,
  type LogDeps,
  type PermissionGate,
  type ScheduledJob,
  type SecretsAccess,
  type StorageNamespace,
} from "@dispatch/kernel";
import { extension as lspExt } from "@dispatch/lsp";
import { extension as mcpExt } from "@dispatch/mcp";
import { extension as messageQueueExt } from "@dispatch/message-queue";
import { extension as providerConcurrencyExt } from "@dispatch/provider-concurrency";
import { extension as providerOpenaiCompatExt } from "@dispatch/provider-openai-compat";
import { extension as providerUmansExt } from "@dispatch/provider-umans";
import { extension as sessionOrchestratorExt } from "@dispatch/session-orchestrator";
import { extension as skillsExt } from "@dispatch/skills";
import { extension as sshExt } from "@dispatch/ssh";
import { createSqliteStorage, extension as storageSqliteExt } from "@dispatch/storage-sqlite";
import { createLoadedExtensionsExtension } from "@dispatch/surface-loaded-extensions";
import { createSurfaceRegistryExtension } from "@dispatch/surface-registry";
import { extension as systemPromptExt } from "@dispatch/system-prompt";
import { extension as throughputStoreExt } from "@dispatch/throughput-store";
import { extension as todoExt } from "@dispatch/todo";
import { extension as toolEditFileExt } from "@dispatch/tool-edit-file";
import { extension as toolReadFileExt } from "@dispatch/tool-read-file";
import { extension as toolShellExt } from "@dispatch/tool-shell";
import { extension as toolWebSearchExt } from "@dispatch/tool-web-search";
import { extension as toolWriteFileExt } from "@dispatch/tool-write-file";
import { extension as toolYoutubeTranscriptExt } from "@dispatch/tool-youtube-transcript";
import { createTransportHttpExtension } from "@dispatch/transport-http";
import { createTransportWsExtension } from "@dispatch/transport-ws";
import { extension as visionHandoffExt } from "@dispatch/vision-handoff";
import type { ChildHandle } from "./collector-supervisor.js";
import { createCollectorSupervisor } from "./collector-supervisor.js";
import { configMapToAccess, envToConfigMap } from "./config.js";
import { loadExternalExtensions } from "./load-external.js";

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

function createNoopScheduler(): { readonly register: (job: ScheduledJob) => void } {
  return { register: () => {} };
}

function createNoopEvents(): EventsEmitter {
  return { emit: () => {} };
}

// Core extensions EXCEPT the credential-store, which is assembled in boot() so
// its credential list can include any credentials backed by external providers
// (e.g. a `claude` credential once the external Anthropic provider is loaded).
const CORE_EXTENSIONS: readonly Extension[] = [
  storageSqliteExt,
  conversationStoreExt,
  authApikeyExt,
  providerOpenaiCompatExt,
  providerUmansExt,
  providerConcurrencyExt,
  // exec-backend must precede the tool extensions that
  // `dependsOn: ["exec-backend"]` (tool-edit-file/read/shell/write). It
  // provides the ExecBackendResolver the tools resolve through; placing it
  // here keeps the activation DAG honest (it depends only on kernel).
  createExecBackendExtension(),
  toolEditFileExt,
  toolReadFileExt,
  toolShellExt,
  toolWriteFileExt,
  toolWebSearchExt,
  toolYoutubeTranscriptExt,
  throughputStoreExt,
  todoExt,
  messageQueueExt,
  mcpExt,
  sessionOrchestratorExt,
  skillsExt,
  systemPromptExt,
  cacheWarmingExt,
  lspExt,
  // ssh declares `dependsOn: ["exec-backend"]` and PROVIDES the remote
  // exec-backend factory + the ComputerService the HTTP routes delegate to.
  // Its lookups are lazy (tool-/request-time), but it is placed after
  // exec-backend and the tool extensions (alongside the other standard
  // tool-serving extensions) to keep the DAG honest — and before
  // transport-http, whose routes consume the ComputerService it provides.
  sshExt,
  // heartbeat PROVIDES the HeartbeatService (per-workspace AI loop) the
  // HTTP routes delegate to. Placed before transport-http (which depends on
  // it) — mirrors how ssh precedes transport-http for the same reason.
  heartbeatExt,
  createTransportHttpExtension(),
  // Surface extensions — dependency order: surface-registry first, then consumers.
  createSurfaceRegistryExtension(),
  createTransportWsExtension(),
  createLoadedExtensionsExtension(),
];

/** Parse the comma-separated list of external extension module specifiers. */
function parseExternalSpecifiers(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env.DISPATCH_EXTERNAL_EXTENSIONS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function boot(): Promise<void> {
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
  const externalExtensions = await loadExternalExtensions(externalSpecifiers, logger);

  // Assemble the credential list. MVP keeps the hardcoded `opencode` credential
  // and adds a `claude` credential when an external Anthropic provider is loaded.
  const credentials = [{ name: "opencode", providerId: "openai-compat" }];

  // The umans credential is always listed (it's the model-catalog index); the
  // provider itself only registers when UMANS_API_KEY is set, so listCatalog
  // gracefully skips it when the provider is absent.
  if (process.env.UMANS_API_KEY) {
    credentials.push({ name: "umans", providerId: "umans" });
    logger.info(`Registered credential "umans" → umans provider`);
  }
  const hasAnthropic = externalExtensions.some((e) =>
    e.manifest.contributes?.providers?.includes("anthropic"),
  );
  if (hasAnthropic) {
    const claudeName = process.env.DISPATCH_CLAUDE_CREDENTIAL ?? "claude";
    credentials.push({ name: claudeName, providerId: "anthropic" });
    logger.info(`Registered credential "${claudeName}" → anthropic provider`);
  }

  const extensions: Extension[] = [
    ...CORE_EXTENSIONS,
    createCredentialStoreExtension({ credentials }),
    // vision-handoff activates AFTER credential-store (it resolves the
    // credential-store service at activate time to find vision-capable models).
    // Placed here, not in CORE_EXTENSIONS, so the service is available when it
    // activates. The session-orchestrator resolves its service LAZILY
    // (per-turn), so activation order between it and session-orchestrator
    // doesn't matter.
    visionHandoffExt,
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

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down — deactivating extensions");
    await host.deactivate();
    logger.info("Draining collector");
    await supervisor?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("Dispatch booted");
  console.info("Dispatch booted");
}

boot().catch((err) => {
  console.error("Fatal boot error:", err);
  process.exit(1);
});
