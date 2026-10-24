import type { Extension, HostAPI, Logger, Manifest, ServiceHandle } from "@dispatch/kernel";
import {
  buildAllowedHosts,
  type NetworkPolicyConfig,
  type NetworkPolicySnapshot,
} from "@dispatch/network-policy";
import { createApp } from "./app.js";
import {
  accountUsageServiceHandle,
  cacheWarmHandle,
  compactionHandle,
  computerServiceHandle,
  concurrencyServiceHandle,
  conversationStoreHandle,
  credentialStoreHandle,
  heartbeatServiceHandle,
  homeTileLayoutHandle,
  layoutProviderRegistryHandle,
  lspServiceHandle,
  mcpServiceHandle,
  namedAgentServiceHandle,
  pluginManagerHandle,
  pluginOwnershipHandle,
  searchConfigServiceHandle,
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
  capabilities: { network: true, fs: true },
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
      "/conversations/:id/tab-group",
      "/conversations/:id/text-file",
      "/conversations/:id/text-file-context",
      "/health",
      "/home/tile-layout/:mode",
      "/models",
      "/metrics/throughput",
      "/named-agents",
      "/named-agents/:id",
      "/plugins",
      "/plugins/scan",
      "/plugins/:id/frontend",
      "/plugins/:id/load",
      "/plugins/:id/unload",
      "/plugins/:id/reload",
      "/plugins/:id/forget",
      "/search/config",
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
      "/workspaces/:id/layout",
      "/workspaces/:id/layout/ops",
      "/workspaces/:id/star",
      "/workspaces/:id/title",
      "/usage",
      "/usage/:provider",
      "/usage/:provider/settings",
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

/** Transport-owned reconciliation; timers/binds are injectable outer edges. */
export function startListeners<T extends { stop(closeActive?: boolean): unknown }>(
  addresses: readonly string[],
  tailscaleIps: readonly string[],
  bind: (address: string) => T,
  logger: Pick<Logger, "warn">,
  schedule: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    return () => clearInterval(timer);
  },
) {
  const active = new Map<string, T>();
  const retries = new Map<string, () => void>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const cancel of retries.values()) cancel();
    retries.clear();
    for (const server of active.values()) server.stop(true);
    active.clear();
  };
  const update = (next: Pick<NetworkPolicySnapshot, "bindAddresses" | "tailscaleIps">) => {
    if (stopped) return;
    const desired = new Set(next.bindAddresses);
    // Withdraw listeners and their active clients, not just future accepts.
    for (const [address, cancel] of retries) {
      if (!desired.has(address)) {
        cancel();
        retries.delete(address);
      }
    }
    for (const [address, server] of active) {
      if (!desired.has(address)) {
        server.stop(true);
        active.delete(address);
      }
    }
    for (const address of desired) {
      if (active.has(address) || retries.has(address)) continue;
      try {
        active.set(address, bind(address));
      } catch (error) {
        if (!next.tailscaleIps.includes(address)) throw error;
        logger.warn("Tailscale bind failed; retrying every 10s", { address });
        const cancel = schedule(() => {
          if (stopped || retries.get(address) !== cancel) return;
          try {
            active.set(address, bind(address));
            retries.get(address)?.();
            retries.delete(address);
          } catch {
            // Remains unavailable; keep the same bounded retry timer.
          }
        }, 10_000);
        retries.set(address, cancel);
      }
    }
  };
  try {
    update({ bindAddresses: addresses, tailscaleIps });
  } catch (error) {
    stop();
    throw error;
  }
  return {
    get servers() {
      return [...active.values()];
    },
    update,
    stop,
  };
}

export function createTransportHttpExtension(): Extension & {
  readonly _testServer: ReturnType<typeof Bun.serve> | undefined;
} {
  let listeners: ReturnType<typeof startListeners<ReturnType<typeof Bun.serve>>> | undefined;
  /** Availability-subscription disposers (disposed on deactivate). */
  let availabilityDisposers: Array<() => void> = [];

  return {
    get _testServer() {
      return listeners?.servers[0];
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
        searchConfig: { current: host.tryGetService(searchConfigServiceHandle) },
        computer: { current: host.tryGetService(computerServiceHandle) },
        concurrency: { current: host.tryGetService(concurrencyServiceHandle) },
        namedAgent: { current: host.tryGetService(namedAgentServiceHandle) },
        pluginManager: { current: host.tryGetService(pluginManagerHandle) },
        workspacePluginConfig: { current: host.tryGetService(workspacePluginConfigHandle) },
        pluginOwnership: { current: host.tryGetService(pluginOwnershipHandle) },
        layoutProviderRegistry: { current: host.tryGetService(layoutProviderRegistryHandle) },
        homeTileLayout: { current: host.tryGetService(homeTileLayoutHandle) },
        accountUsage: { current: host.tryGetService(accountUsageServiceHandle) },
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
        watch(searchConfigServiceHandle, slots.searchConfig),
        watch(computerServiceHandle, slots.computer),
        watch(concurrencyServiceHandle, slots.concurrency),
        watch(namedAgentServiceHandle, slots.namedAgent),
        watch(pluginManagerHandle, slots.pluginManager),
        watch(workspacePluginConfigHandle, slots.workspacePluginConfig),
        watch(pluginOwnershipHandle, slots.pluginOwnership),
        watch(layoutProviderRegistryHandle, slots.layoutProviderRegistry),
        watch(homeTileLayoutHandle, slots.homeTileLayout),
        watch(accountUsageServiceHandle, slots.accountUsage),
      ];

      const logger = host.logger;
      const policy = host.config.get<NetworkPolicyConfig>("networkPolicy") ?? {
        allowedHosts: buildAllowedHosts({ env: {} }),
        bindAddresses: ["127.0.0.1", "::1"],
        tailscaleIps: [],
      };
      // Stable request-policy view: guards/CORS see the latest complete publication.
      const allowedHosts = new Set(policy.allowedHosts);

      const imageDir = host.config.get<string>("vision.imageDir");

      // The optional services are passed as LIVE GETTERS: each request
      // re-reads the slot's current value (undefined → the route's degrade
      // path), so the app never holds a stale service reference.
      const app = createApp({
        allowedHosts,
        ...(imageDir !== undefined ? { imageDir } : {}),
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
        get searchConfigService() {
          return slots.searchConfig.current;
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
        get layoutProviderRegistry() {
          return slots.layoutProviderRegistry.current;
        },
        get homeTileLayout() {
          return slots.homeTileLayout.current;
        },
        get accountUsageService() {
          return slots.accountUsage.current;
        },
        // Live tier lookup over the loaded manifests (plan 06 §6.5) — read
        // per call so mid-session loads/unloads are seen on the next
        // request. `undefined` tier → the route's fail-open path.
        pluginTierOf: (pluginId) => host.getExtensions().find((m) => m.id === pluginId)?.tier,
      });

      const port = host.config.get<number>("httpPort") ?? 24203;

      try {
        listeners = startListeners(
          policy.bindAddresses,
          policy.tailscaleIps,
          (hostname) => Bun.serve({ hostname, port, fetch: app.fetch, idleTimeout: 0 }),
          logger,
        );
        const unsubscribe = policy.subscribe?.((next) => {
          allowedHosts.clear();
          for (const host of next.allowedHosts) allowedHosts.add(host);
          listeners?.update(next);
        });
        if (unsubscribe) availabilityDisposers.push(unsubscribe);
      } catch (error) {
        listeners?.stop();
        listeners = undefined;
        for (const dispose of availabilityDisposers) dispose();
        availabilityDisposers = [];
        throw error;
      }

      logger.info("transport-http: listening", { port });
    },

    deactivate() {
      // Disposal contract: the availability subscriptions this extension
      // created are its own — dispose them (the ledger-wrapped disposers are
      // idempotent; the host force-cleans any we somehow missed).
      for (const dispose of availabilityDisposers) dispose();
      availabilityDisposers = [];
      listeners?.stop();
      listeners = undefined;
    },
  };
}
