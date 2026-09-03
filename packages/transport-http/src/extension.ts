import type { Extension, HostAPI, Manifest, ServiceHandle } from "@dispatch/kernel";
import { createApp } from "./app.js";
import {
  cacheWarmHandle,
  compactionHandle,
  computerServiceHandle,
  concurrencyServiceHandle,
  conversationStoreHandle,
  credentialStoreHandle,
  heartbeatServiceHandle,
  lspServiceHandle,
  mcpServiceHandle,
  namedAgentServiceHandle,
  pluginManagerHandle,
  pluginOwnershipHandle,
  sessionOrchestratorHandle,
  systemPromptHandle,
  throughputStoreHandle,
  workspacePluginConfigHandle,
} from "./seam.js";

export const manifest: Manifest = {
  id: "transport-http",
  name: "Transport HTTP",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "core",
  trust: "bundled",
  // Core depends only on core (AGENTS.md): the Standard-provided services this
  // transport consumes (heartbeat, mcp, throughput-store, named-agents, and
  // the optional lsp / ssh / provider surfaces) are resolved REACTIVELY via
  // the kernel's service registry (tryGetService + availability
  // subscriptions) — never via a dependsOn edge or an activate-time
  // getService. An absent Standard plugin degrades its routes to 503/empty;
  // a mid-session load starts serving them with no restart (plan 03).
  dependsOn: ["conversation-store", "credential-store", "session-orchestrator"],
  capabilities: { network: true },
  contributes: {
    routes: [
      "/chat",
      "/chat/warm",
      "/computers",
      "/computers/:alias",
      "/computers/:alias/status",
      "/computers/:alias/test",
      "/concurrency/limits",
      "/concurrency/limits/:providerId",
      "/concurrency/status",
      "/conversations",
      "/conversations/:id",
      "/conversations/:id/close",
      "/conversations/:id/compact",
      "/conversations/:id/compact-percent",
      "/conversations/:id/computer",
      "/conversations/:id/cwd",
      "/conversations/:id/last",
      "/conversations/:id/lsp",
      "/conversations/:id/mcp",
      "/conversations/:id/open",
      "/conversations/:id/queue",
      "/conversations/:id/queue/:messageId",
      "/conversations/:id/reasoning-effort",
      "/conversations/:id/status",
      "/conversations/:id/stop",
      "/conversations/:id/title",
      "/health",
      "/models",
      "/metrics/throughput",
      "/named-agents",
      "/named-agents/:id",
      "/plugins",
      "/plugins/scan",
      "/plugins/:id/load",
      "/plugins/:id/unload",
      "/plugins/:id/reload",
      "/plugins/:id/forget",
      "/system-prompt",
      "/system-prompt/variables",
      "/workspaces",
      "/workspaces/:id",
      "/workspaces/:id/default-cwd",
      "/workspaces/:id/default-computer",
      "/workspaces/:id/heartbeat",
      "/workspaces/:id/heartbeat/runs",
      "/workspaces/:id/heartbeat/runs/:runId/stop",
      "/workspaces/:id/plugins",
      "/workspaces/:id/plugins/providers-status",
      "/workspaces/:id/plugins/:pluginId",
      "/workspaces/:id/star",
      "/workspaces/:id/title",
    ],
  },
  activation: "eager",
};

/**
 * A reactive service slot: the CURRENT provider of a service handle (or
 * undefined while absent). Availability subscriptions keep it fresh, and the
 * HTTP routes read it per request — so the consuming surface always sees the
 * live registry state (a plugin loaded/unloaded mid-session is picked up on
 * the next request, no restart). Slots are plain `{ current }` holders typed
 * inline at each use below.
 */

export function createTransportHttpExtension(): Extension & {
  readonly _testServer: ReturnType<typeof Bun.serve> | undefined;
} {
  let server: ReturnType<typeof Bun.serve> | undefined;
  /** Availability-subscription disposers (disposed on deactivate). */
  let availabilityDisposers: Array<() => void> = [];

  return {
    get _testServer() {
      return server;
    },
    manifest,
    async activate(host: HostAPI) {
      // Mandatory core→core services — guaranteed by dependsOn; getService
      // (throwing) is the correct pattern for them.
      const conversationStore = host.getService(conversationStoreHandle);
      const orchestrator = host.getService(sessionOrchestratorHandle);
      const credentialStore = host.getService(credentialStoreHandle);
      const warmService = host.getService(cacheWarmHandle);
      const compactionService = host.getService(compactionHandle);
      const systemPromptService = host.getService(systemPromptHandle);

      // ── Reactive consumption of optional services (plan 03) ───────────────
      // Each optional service — the Standard-provided heartbeat / mcp /
      // throughput-store / named-agents / lsp / ssh, and the core-provided
      // concurrency limiter — lives in a slot seeded from the registry and
      // kept fresh by availability subscriptions. Routes read the slot per
      // request and degrade to 503/empty when it is empty; a mid-session
      // load/unload is picked up on the next request (no dependsOn edge, no
      // restart). `named-agents` was previously in dependsOn with a
      // defensive try/catch; it now consumes the registry like the rest.
      const slots = {
        throughput: { current: host.tryGetService(throughputStoreHandle) },
        lsp: { current: host.tryGetService(lspServiceHandle) },
        mcp: { current: host.tryGetService(mcpServiceHandle) },
        heartbeat: { current: host.tryGetService(heartbeatServiceHandle) },
        computer: { current: host.tryGetService(computerServiceHandle) },
        concurrency: { current: host.tryGetService(concurrencyServiceHandle) },
        namedAgent: { current: host.tryGetService(namedAgentServiceHandle) },
        pluginManager: { current: host.tryGetService(pluginManagerHandle) },
        workspacePluginConfig: { current: host.tryGetService(workspacePluginConfigHandle) },
        pluginOwnership: { current: host.tryGetService(pluginOwnershipHandle) },
      };

      function watch<T>(handle: ServiceHandle<T>, slot: { current: T | undefined }): () => void {
        const onAvailable = host.onServiceAvailable(handle, (impl) => {
          slot.current = impl;
        });
        const onUnavailable = host.onServiceUnavailable(handle, () => {
          slot.current = undefined;
        });
        return () => {
          onAvailable();
          onUnavailable();
        };
      }

      availabilityDisposers = [
        watch(throughputStoreHandle, slots.throughput),
        watch(lspServiceHandle, slots.lsp),
        watch(mcpServiceHandle, slots.mcp),
        watch(heartbeatServiceHandle, slots.heartbeat),
        watch(computerServiceHandle, slots.computer),
        watch(concurrencyServiceHandle, slots.concurrency),
        watch(namedAgentServiceHandle, slots.namedAgent),
        watch(pluginManagerHandle, slots.pluginManager),
        watch(workspacePluginConfigHandle, slots.workspacePluginConfig),
        watch(pluginOwnershipHandle, slots.pluginOwnership),
      ];

      const logger = host.logger;

      // The optional services are passed as LIVE GETTERS: each request
      // re-reads the slot's current value (undefined → the route's degrade
      // path), so the app never holds a stale service reference.
      const app = createApp({
        conversationStore,
        orchestrator,
        credentialStore,
        warmService,
        compactionService,
        systemPromptService,
        logger,
        emit: host.emit.bind(host),
        ...(process.env.DISPATCH_WEB_DIR !== undefined
          ? { webDir: process.env.DISPATCH_WEB_DIR }
          : {}),
        get throughputStore() {
          return slots.throughput.current;
        },
        get lspService() {
          return slots.lsp.current;
        },
        get mcpService() {
          return slots.mcp.current;
        },
        get heartbeatService() {
          return slots.heartbeat.current;
        },
        get computerService() {
          return slots.computer.current;
        },
        get concurrencyService() {
          return slots.concurrency.current;
        },
        get namedAgentService() {
          return slots.namedAgent.current;
        },
        get pluginManagerService() {
          return slots.pluginManager.current;
        },
        get workspacePluginConfigService() {
          return slots.workspacePluginConfig.current;
        },
        get pluginOwnership() {
          return slots.pluginOwnership.current;
        },
        // Live tier lookup over the loaded manifests (plan 06 §6.5) — read
        // per call so mid-session loads/unloads are seen on the next
        // request. `undefined` tier → the route's fail-open path.
        pluginTierOf: (pluginId) => host.getExtensions().find((m) => m.id === pluginId)?.tier,
      });

      const port = host.config.get<number>("httpPort") ?? 24203;

      server = Bun.serve({
        port,
        fetch: app.fetch,
        idleTimeout: 0,
      });

      logger.info("transport-http: listening", { port });
    },

    deactivate() {
      // Disposal contract: the availability subscriptions this extension
      // created are its own — dispose them (the ledger-wrapped disposers are
      // idempotent; the host force-cleans any we somehow missed).
      for (const dispose of availabilityDisposers) dispose();
      availabilityDisposers = [];
      if (server) {
        server.stop();
        server = undefined;
      }
    },
  };
}
