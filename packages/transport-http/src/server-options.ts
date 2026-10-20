import type { HomeTileLayoutService } from "@dispatch/home-tile-layout-contract";
import type { HostAPI, Logger, PluginTier } from "@dispatch/kernel";
import type { LayoutProviderRegistry } from "@dispatch/layout-provider-contract";
import type {
  AccountUsageService,
  CompactionService,
  ComputerService,
  ConcurrencyService,
  ConversationStore,
  CredentialStore,
  HeartbeatService,
  LspService,
  McpService,
  NamedAgentsService,
  PluginManagerService,
  PluginOwnership,
  SearchConfigService,
  SessionOrchestrator,
  SystemPromptService,
  ThroughputStore,
  WarmService,
  WorkspacePluginConfigService,
} from "./seam.js";

export interface CreateServerOptions {
  readonly allowedHosts?: ReadonlySet<string>;
  readonly conversationStore: ConversationStore;
  readonly orchestrator: SessionOrchestrator;
  readonly credentialStore: CredentialStore;
  readonly warmService?: WarmService;
  readonly compactionService?: CompactionService;
  /**
   * Optional + reactive: read PER REQUEST (the extension passes a live
   * getter over a registry slot). `| undefined` is explicit so a getter
   * returning the slot's current value typechecks under
   * exactOptionalPropertyTypes — an absent service (extension not loaded or
   * unloaded mid-session) takes the route's degrade path.
   */
  readonly lspService?: LspService | undefined;
  readonly mcpService?: McpService | undefined;
  /** Optional — system prompt builder service (GET/PUT template). */
  readonly systemPromptService?: SystemPromptService;
  /**
   * Optional + reactive — per-workspace heartbeat loop service (provided by
   * the `heartbeat` extension; read per request via a registry slot). When
   * absent (heartbeat not loaded / unloaded mid-session), the
   * `/workspaces/:id/heartbeat*` routes degrade: GET returns defaults,
   * PUT/POST return 503.
   */
  readonly heartbeatService?: HeartbeatService | undefined;
  /**
   * Optional + reactive — the GLOBAL search-backend selection service
   * (provided by the `tool-web-search` extension; read per request via a
   * registry slot). When absent (extension not loaded / unloaded
   * mid-session), the `/search/config` routes degrade: GET returns the
   * defaults (firecrawl, firecrawl-only), PUT returns 503.
   */
  readonly searchConfigService?: SearchConfigService | undefined;
  /**
   * Optional + reactive — computer discovery + live connection service
   * (provided by the `ssh` extension; read per request via a registry slot).
   * When absent (ssh not loaded), the `/computers*` routes degrade: list
   * returns `[]`, status returns "disconnected", test returns a
   * not-configured result. The per-conversation / workspace-default computer
   * endpoints work regardless (they only touch the conversation store).
   */
  readonly computerService?: ComputerService | undefined;
  /**
   * Optional + reactive — throughput metrics store (provided by the
   * `throughput-store` extension; read per use via a registry slot). When
   * absent, recording is a no-op and aggregate reports are empty.
   */
  readonly throughputStore?: ThroughputStore | undefined;
  /**
   * Optional + reactive — provider concurrency limiter service (provided by
   * the `provider-concurrency` extension; read per request via a registry
   * slot). When absent (extension not loaded), the `/concurrency/*` routes
   * degrade: limits returns empty, status returns empty, PUT returns 503.
   */
  readonly concurrencyService?: ConcurrencyService | undefined;
  /**
   * Optional + reactive — the Named Agent registry service (provided by the
   * `named-agents` extension; read per request via a registry slot). When
   * absent (extension not loaded / unloaded mid-session), the `/named-agents*`
   * routes degrade: GET/POST/PUT/DELETE return 503. When present, the routes
   * delegate to this typed service — never a raw store — and perform ZERO
   * provider-catalog calls (the registry is local config).
   */
  readonly namedAgentService?: NamedAgentsService | undefined;
  /**
   * Optional + reactive — the plugin-manager service (provided by the core
   * `plugin-manager` extension; read per request via a registry slot). When
   * absent (somehow not activated), the `/plugins*` routes degrade to 503.
   * Route handlers are thin shells: parse → delegate → map the structured
   * result to a status (200 ok / 400 invalid body / 404 not-found /
   * 409 blocked-with-reason / 500 engine failure / 503 absent).
   */
  readonly pluginManagerService?: PluginManagerService | undefined;
  /**
   * Optional + reactive — the per-workspace plugin enablement store
   * (provided by the core `workspace-plugin-config` extension; read per
   * request via a registry slot). When absent, the
   * `/workspaces/:id/plugins*` routes degrade to 503 and `GET /models` with
   * a `workspaceId` query degrades to 503 (without the param `/models`
   * stays global and needs NO service — backward compatible). Route
   * handlers are thin shells: parse → delegate to the service → map to
   * HTTP (the state-transition + validation logic lives in the service).
   */
  readonly workspacePluginConfigService?: WorkspacePluginConfigService | undefined;
  /**
   * Optional + reactive — the plan-06 `PluginOwnership` seam (the
   * composition root adapts it from the kernel host's registration-ledger
   * views). `GET /models?workspaceId=` uses it to attribute each provider
   * to its owning plugin; absent → that route degrades to 503 (the
   * per-workspace gate must not silently over- or under-filter).
   */
  readonly pluginOwnership?: PluginOwnership | undefined;
  /**
   * Optional + reactive — the layout-provider REGISTRY (plan 02, evolved for
   * per-workspace activation; provided by the bundled standard
   * `layout-provider-registry` extension; every loaded layout plugin
   * registers into it). Read per request via a registry slot; the routes
   * resolve the WORKSPACE's one enabled layout plugin through
   * `providerFor(workspaceId)` — the per-workspace enablement state decides
   * which plugin serves. When absent (nothing registered / the registry
   * unloaded mid-session) or when the workspace enables no layout plugin,
   * the `/workspaces/:id/layout` routes degrade to 404 — the frontend's
   * no-provider signal — and the decision logic (status mapping, body
   * validation) lives in the provider kit; this transport mounts the
   * handlers as thin shells (D-L6: no layout knowledge here).
   */
  readonly layoutProviderRegistry?: LayoutProviderRegistry | undefined;
  /**
   * Optional + reactive — the home tile-layout SERVICE (provided by the
   * bundled standard `home-tile-layout` extension; ONE shared document per
   * device orientation, wide/tall). Read per request via a service slot;
   * when absent (plugin unloaded mid-session) the `/home/tile-layout/:mode`
   * routes degrade to 503. The decision logic (mode validation, body
   * parsing, status mapping) lives in the contract kit
   * (`createTileLayoutRouteHandlers`); this transport mounts the handlers as
   * thin shells (D-L6: no tile-document knowledge here).
   */
  readonly homeTileLayout?: HomeTileLayoutService | undefined;
  /**
   * Optional + reactive — Claude/Codex subscription usage (provided by the
   * standard `account-usage` extension; read per request via a registry
   * slot). When absent, `GET /usage*` degrades to 503.
   */
  readonly accountUsageService?: AccountUsageService | undefined;
  /**
   * Live tier lookup over the host's loaded manifests (wired by the
   * extension from `host.getExtensions()`). Used by `GET /models?workspaceId=`
   * to classify a provider's owning plugin; `undefined` tier → fail-open.
   */
  readonly pluginTierOf?: (pluginId: string) => PluginTier | undefined;
  readonly logger?: Logger;
  readonly generateId?: () => string;
  /** Injectable clock for sample timestamps (default Date.now). */
  readonly now?: () => number;
  /**
   * Fire-and-forget event-bus emit (bound `host.emit`). Required by
   * `POST /conversations/:id/open` and `PUT /conversations/:id/tab-group` to
   * signal the frontend. When absent, those endpoints respond with
   * `500 { error: "not available" }` without writing.
   */
  readonly emit?: HostAPI["emit"];
  /**
   * Directory containing built frontend static files. When set, unmatched GET
   * requests fall through to static file serving (SPA fallback to index.html).
   * When absent, no static serving (API-only — backward compatible).
   */
  readonly webDir?: string;
}
