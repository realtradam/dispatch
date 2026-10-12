/**
 * The bundled extension set — every extension shipped compiled into the
 * binary/dev entry, handed to the host as ONE order-independent array.
 *
 * De-curated (plan 02): this file does NOT curate tiers or hand-write
 * activation order. Classification is declarative — every manifest carries
 * `tier` — and ordering is manifest-declared: the host sorts by the
 * `dependsOn` DAG and gates by apiVersion, so array order here is
 * irrelevant. A core→standard dependency edge is a classification bug
 * (AGENTS.md), detectable with `findCoreToStandardDeps` — see
 * `bundled.test.ts` for the live canary over this set.
 *
 * Credential assembly stays in `main.ts` (host-bin composition-root work —
 * env → credential list). The credential-store extension is created here
 * with that list. Runtime credential registration for mid-session providers
 * is OUT OF SCOPE (plan 00 Q-C): credentials are fixed at boot.
 */
import { extension as agentManagementExt } from "@dispatch/agent-management";
import { extension as cacheWarmingExt } from "@dispatch/cache-warming";
import { extension as conversationStoreExt } from "@dispatch/conversation-store";
import { type Credential, createCredentialStoreExtension } from "@dispatch/credential-store";
import { createExecBackendExtension } from "@dispatch/exec-backend";
import { extension as heartbeatExt } from "@dispatch/heartbeat";
import { extension as homeTileLayoutExt } from "@dispatch/home-tile-layout";
import type { Extension } from "@dispatch/kernel";
import { extension as layoutChatExt } from "@dispatch/layout-chat";
import { extension as layoutDiagnosticExt } from "@dispatch/layout-diagnostic";
import { createLayoutProviderRegistryExtension } from "@dispatch/layout-provider-registry";
import { extension as lspExt } from "@dispatch/lsp";
import { extension as mcpExt } from "@dispatch/mcp";
import { extension as messageQueueExt } from "@dispatch/message-queue";
import { extension as namedAgentsExt } from "@dispatch/named-agents";
import { extension as pluginManagerExt } from "@dispatch/plugin-manager";
import { extension as providerBasetenExt } from "@dispatch/provider-baseten";
import { extension as providerConcurrencyExt } from "@dispatch/provider-concurrency";
import { extension as providerHyperExt } from "@dispatch/provider-hyper";
import { extension as providerLongcatExt } from "@dispatch/provider-longcat";
import { extension as providerOpenaiCompatExt } from "@dispatch/provider-openai-compat";
import { extension as providerOpenRouterExt } from "@dispatch/provider-openrouter";
import { extension as providerUmansExt } from "@dispatch/provider-umans";
import { extension as sessionOrchestratorExt } from "@dispatch/session-orchestrator";
import { extension as skillsExt } from "@dispatch/skills";
import { extension as sshExt } from "@dispatch/ssh";
import { extension as storageSqliteExt } from "@dispatch/storage-sqlite";
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
import { extension as workspacePluginConfigExt } from "@dispatch/workspace-plugin-config";

// Factory extensions are constructed once at module load (pure configuration
// — no I/O happens until the host activates them).
const surfaceRegistry = createSurfaceRegistryExtension();
const transportHttp = createTransportHttpExtension();
const transportWs = createTransportWsExtension();
const loadedExtensionsSurface = createLoadedExtensionsExtension();

/**
 * Build the bundled extension set. `credentials` is the env-derived
 * credential list assembled in `main.ts`; it seeds the credential-store.
 */
export function createBundledExtensions(creds: {
  credentials: readonly Credential[];
}): Extension[] {
  return [
    // Tier grouping below is documentation, not semantics: the host resolves
    // activation order from the manifests' dependsOn DAG.
    // --- core ---
    storageSqliteExt,
    conversationStoreExt,
    providerConcurrencyExt,
    createExecBackendExtension(),
    toolEditFileExt,
    toolReadFileExt,
    toolShellExt,
    toolWriteFileExt,
    systemPromptExt,
    // The per-workspace plugin enablement store (plan 06, tier core): the
    // enforcement plane (tool gate, model gate, surface filter) reads it
    // every turn, so it must always be loaded. Activates anywhere — every
    // consumer reads it reactively (plan 03).
    workspacePluginConfigExt,
    sessionOrchestratorExt,
    // The plugin control plane (plan 05) — activates after the host engine
    // (provided pre-activation by main.ts) and storage are available.
    pluginManagerExt,
    surfaceRegistry,
    transportWs,
    transportHttp,
    createCredentialStoreExtension({ credentials: creds.credentials }),
    // --- providers ---
    providerUmansExt,
    providerLongcatExt,
    providerHyperExt,
    providerOpenRouterExt,
    providerBasetenExt,
    // Always loaded — with no numbered credentials configured it
    // self-degrades (registers nothing; OpenCode unavailable).
    providerOpenaiCompatExt,
    // --- standard ---
    namedAgentsExt,
    heartbeatExt,
    sshExt,
    mcpExt,
    messageQueueExt,
    throughputStoreExt,
    visionHandoffExt,
    agentManagementExt,
    toolWebSearchExt,
    toolYoutubeTranscriptExt,
    todoExt,
    skillsExt,
    cacheWarmingExt,
    loadedExtensionsSurface,
    // Plan-08 mechanism pilot (§12): lsp runs through the new system as a
    // bundled STANDARD plugin with a blank (undefined) per-workspace default —
    // INERT everywhere until a workspace opts in (the plan-06 tool gate hides
    // its tool; the surface/model gates do the same for their planes). Still
    // KNOWN-BROKEN when used (unhandled JSON parse, ENOENT on transient
    // .old_modules dirs, memory leak — commit 73ff84c); fixing it is out of
    // scope. The pilot proves the load/unload/enable machinery on a real,
    // non-trivial plugin.
    lspExt,
    // The per-workspace layout ACTIVATION plane: the registry every loaded
    // layout plugin registers its provider into; the workspace's per-
    // workspace enablement state (workspace-plugin-config) picks the ONE
    // active provider per workspace. Coexisting layout plugins are the
    // design — activation is per workspace (the plugins modal's checkboxes).
    createLayoutProviderRegistryExtension(),
    // The default-layout provider (plan 02, D-L3): a bundled STANDARD plugin
    // that owns per-workspace tile trees (its own storage namespace) for the
    // workspaces that ENABLE it, serves the well-known
    // /workspaces/:id/layout routes there, and broadcasts `layout` WS
    // changes. Registration is order-independent (reactive, into the
    // registry) — a workspace without it enabled (or with no layout plugin
    // enabled) 404s the routes, and clients render their built-in default
    // with ephemeral edits (graceful degrade).
    layoutChatExt,
    // The DIAGNOSTIC layout provider: the same generic machinery (plan-02
    // kit, same routes, its own tree) seeding the default tree with border
    // markers on the two root tiles (main = red, side = green) so a human can
    // SEE which tile is which in the browser. Coexists with layout-chat —
    // enable layout-diagnostic in a workspace's plugins (and disable
    // layout-chat there) to make THIS plugin that workspace's layout
    // provider; the frontend then renders the marked tree. No restart, no
    // unload dance.
    layoutDiagnosticExt,
    // The home grid's SYNCED tile layouts (one shared document per device
    // orientation — `wide` = landscape/desktop, `tall` = portrait/mobile):
    // its own storage namespace, the well-known /home/tile-layout/:mode
    // routes (mounted by transport-http over the reactive service slot), and
    // the `tile-layout` WS broadcast (ferried by transport-ws). ALWAYS-ON —
    // the home grid is a global surface, so unlike the layout providers
    // there is no per-workspace enablement; a device's only degrade is a
    // genuinely absent backend (ephemeral edits, no error UI).
    homeTileLayoutExt,
  ];
}
