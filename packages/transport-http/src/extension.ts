import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createApp } from "./app.js";
import {
  type ComputerService,
  type ConcurrencyService,
  cacheWarmHandle,
  compactionHandle,
  computerServiceHandle,
  concurrencyServiceHandle,
  conversationStoreHandle,
  credentialStoreHandle,
  heartbeatServiceHandle,
  type LspService,
  lspServiceHandle,
  mcpServiceHandle,
  sessionOrchestratorHandle,
  systemPromptHandle,
  throughputStoreHandle,
} from "./seam.js";

export const manifest: Manifest = {
  id: "transport-http",
  name: "Transport HTTP",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  dependsOn: [
    "conversation-store",
    "credential-store",
    "heartbeat",
    "mcp",
    "session-orchestrator",
    "throughput-store",
  ],
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
      "/conversations/:id/reasoning-effort",
      "/conversations/:id/status",
      "/conversations/:id/stop",
      "/conversations/:id/title",
      "/health",
      "/models",
      "/metrics/throughput",
      "/system-prompt",
      "/system-prompt/variables",
      "/workspaces",
      "/workspaces/:id",
      "/workspaces/:id/default-cwd",
      "/workspaces/:id/default-computer",
      "/workspaces/:id/heartbeat",
      "/workspaces/:id/heartbeat/runs",
      "/workspaces/:id/heartbeat/runs/:runId/stop",
      "/workspaces/:id/star",
      "/workspaces/:id/title",
    ],
  },
  activation: "eager",
};

export function createTransportHttpExtension(): Extension & {
  readonly _testServer: ReturnType<typeof Bun.serve> | undefined;
} {
  let server: ReturnType<typeof Bun.serve> | undefined;

  return {
    get _testServer() {
      return server;
    },
    manifest,
    async activate(host: HostAPI) {
      const conversationStore = host.getService(conversationStoreHandle);
      const orchestrator = host.getService(sessionOrchestratorHandle);
      const credentialStore = host.getService(credentialStoreHandle);
      const throughputStore = host.getService(throughputStoreHandle);
      const warmService = host.getService(cacheWarmHandle);
      const compactionService = host.getService(compactionHandle);
      // Optional: the `lsp` extension may be disabled (hot-fix). Wrapped because
      // getService throws for an unregistered handle — degrades to no diagnostics.
      let lspService: LspService | undefined;
      try {
        lspService = host.getService(lspServiceHandle);
      } catch {
        lspService = undefined;
      }
      const mcpService = host.getService(mcpServiceHandle);
      const systemPromptService = host.getService(systemPromptHandle);
      const heartbeatService = host.getService(heartbeatServiceHandle);
      // Optional: the `ssh` extension provides ComputerService. It is NOT in
      // dependsOn (ssh may be absent), so resolve defensively — when no
      // provider registered the handle, the computer routes degrade to
      // empty/disconnected (see app.ts). Wrapped because getService throws
      // for an unregistered handle.
      let computerService: ComputerService | undefined;
      try {
        computerService = host.getService(computerServiceHandle);
      } catch {
        computerService = undefined;
      }
      // Optional: the `provider-concurrency` extension provides the
      // concurrency limiter service. NOT in dependsOn (may be absent), so
      // resolve defensively — when absent the /concurrency/* routes degrade.
      let concurrencyService: ConcurrencyService | undefined;
      try {
        concurrencyService = host.getService(concurrencyServiceHandle);
      } catch {
        concurrencyService = undefined;
      }
      const logger = host.logger;

      const app = createApp({
        conversationStore,
        orchestrator,
        credentialStore,
        throughputStore,
        warmService,
        compactionService,
        ...(lspService !== undefined ? { lspService } : {}),
        mcpService,
        systemPromptService,
        heartbeatService,
        ...(computerService !== undefined ? { computerService } : {}),
        ...(concurrencyService !== undefined ? { concurrencyService } : {}),
        logger,
        emit: host.emit.bind(host),
        ...(process.env.DISPATCH_WEB_DIR !== undefined
          ? { webDir: process.env.DISPATCH_WEB_DIR }
          : {}),
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
      if (server) {
        server.stop();
        server = undefined;
      }
    },
  };
}
