<script lang="ts">
import { DEFAULT_REASONING_EFFORT } from "@dispatch/core/src/types/index.js";
import { onMount } from "svelte";
import AgentBuilder from "./lib/components/AgentBuilder.svelte";
import ChatInput from "./lib/components/ChatInput.svelte";
import ChatPanel from "./lib/components/ChatPanel.svelte";
import Header from "./lib/components/Header.svelte";
import HotReloadIndicator from "./lib/components/HotReloadIndicator.svelte";
import PermissionPrompt from "./lib/components/PermissionPrompt.svelte";
import SidebarPanel from "./lib/components/SidebarPanel.svelte";
import TabBar from "./lib/components/TabBar.svelte";
import { config } from "./lib/config.js";
import { router } from "./lib/router.svelte.js";
import { tabStore } from "./lib/tabs.svelte.js";
import { applyTheme, loadStoredTheme } from "./lib/theme.js";
import type { KeyInfo } from "./lib/types.js";
import { wsClient } from "./lib/ws.svelte.js";

let modelsData = $state<{ keys: KeyInfo[] }>({
	keys: [],
});

let sidebarOpen = $state(true);

// Add Key modal state (rendered at page level to escape sidebar transform)
let showAddKeyModal = $state(false);
let addKeyProvider = $state("anthropic");
let addKeyId = $state("");
let addKeyError = $state<string | null>(null);
let addKeySaving = $state(false);

async function addNewKey(): Promise<void> {
	if (!addKeyId.trim()) return;
	addKeySaving = true;
	addKeyError = null;
	try {
		const res = await fetch(`${config.apiBase}/models/add-key`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: addKeyId.trim(), provider: addKeyProvider }),
		});
		const data = (await res.json()) as { success?: boolean; error?: string };
		if (!res.ok || !data.success) {
			addKeyError = data.error ?? "Failed to add key";
		} else {
			showAddKeyModal = false;
			addKeyId = "";
			addKeyProvider = "anthropic";
			await new Promise((r) => setTimeout(r, 500));
			window.location.reload();
		}
	} catch (e) {
		addKeyError = e instanceof Error ? e.message : "Network error";
	} finally {
		addKeySaving = false;
	}
}

async function fetchModels() {
	try {
		const res = await fetch(`${config.apiBase}/models`);
		if (!res.ok) return;
		const data = await res.json();
		modelsData = {
			keys: data.keys ?? [],
		};
	} catch {
		// ignore fetch errors
	}
}

$effect(() => {
	if (tabStore.configReloaded) {
		fetchModels();
	}
});

// ─── Context-window max lookup ─────────────────────────────────
// Resolve the active model's MAXIMUM context window from models.dev (via the
// API), so the Context Window sidebar view can show `current / max`. Cached
// per provider+model; `null` when unknown (the view then hides the
// denominator/percentage). Only Claude-backed providers are resolvable.
let contextLimit = $state<number | null>(null);
const contextLimitCache = new Map<string, number | null>();

$effect(() => {
	const tab = tabStore.activeTab;
	const keyId = tab?.keyId ?? null;
	const modelId = tab?.modelId ?? null;
	const provider = keyId ? (modelsData.keys.find((k) => k.id === keyId)?.provider ?? null) : null;

	if (!provider || !modelId) {
		contextLimit = null;
		return;
	}

	const cacheKey = `${provider}/${modelId}`;
	if (contextLimitCache.has(cacheKey)) {
		contextLimit = contextLimitCache.get(cacheKey) ?? null;
		return;
	}

	// Clear immediately so a slow/failed fetch can't leave the PREVIOUS
	// model's max on screen (which would render this model's tokens against
	// the wrong denominator). The view degrades to a bare token count until
	// the fetch resolves.
	contextLimit = null;

	// Fetch is async; guard against a stale response overwriting a newer
	// selection by re-checking the active tab's key/model on resolve.
	void (async () => {
		try {
			const res = await fetch(
				`${config.apiBase}/models/context-limit?provider=${encodeURIComponent(provider)}&modelId=${encodeURIComponent(modelId)}`,
			);
			if (!res.ok) return;
			const data = (await res.json()) as { contextLimit?: number | null };
			const limit = data.contextLimit ?? null;
			contextLimitCache.set(cacheKey, limit);
			const current = tabStore.activeTab;
			const currentProvider = current?.keyId
				? (modelsData.keys.find((k) => k.id === current.keyId)?.provider ?? null)
				: null;
			if (currentProvider === provider && current?.modelId === modelId) {
				contextLimit = limit;
			}
		} catch {
			// Leave contextLimit as-is on network error; view falls back to
			// showing the bare token count.
		}
	})();
});

onMount(() => {
	// Apply persisted theme (or the shared DEFAULT_THEME if nothing is
	// stored) so the first paint matches what the Settings panel will
	// show as the selected option. Without this, daisyUI falls back to
	// the first theme in `app.css` (light) while Settings shows "dark".
	applyTheme(loadStoredTheme());

	// Connect WebSocket in parallel with hydration. The `statuses`
	// snapshot delivered on WS open is idempotent against
	// already-hydrated tabs (the handler reconciles per-tab).
	wsClient.connect();

	// Initial models fetch (fire-and-forget; UI tolerates models
	// arriving later than tabs).
	fetchModels();

	// Restore tabs from the backend. The user's previous session is
	// the source of truth; only fall back to a fresh tab if nothing
	// was restored (first-ever load, or DB was wiped, or HTTP failed).
	void (async () => {
		const restored = await tabStore.hydrateFromBackend();
		if (restored === 0 && tabStore.tabs.length === 0) {
			await tabStore.createNewTab();
		}
	})();

	return () => {
		wsClient.disconnect();
	};
});
</script>

<div class="flex flex-col h-screen overflow-hidden">
	<Header onToggleSidebar={() => sidebarOpen = !sidebarOpen} />

	{#if router.page === "dashboard"}
	<div class="flex flex-1 overflow-hidden relative">
		<!-- Main chat area -->
		<div class="flex flex-col flex-1 min-w-0 overflow-hidden">
			<TabBar />
			<div class="flex-1 overflow-hidden">
				<ChatPanel />
			</div>
			<ChatInput {contextLimit} />
		</div>

		<!-- Right sidebar: overlay on small screens, inline on large -->
		<div
			class="shrink-0 overflow-x-hidden flex flex-col transition-[width] duration-300 ease-out
				sm:relative sm:z-auto
				absolute right-0 top-0 bottom-0 z-30"
			class:w-80={sidebarOpen}
			class:w-0={!sidebarOpen}
		>
		<div
			class="w-80 flex-1 min-h-0 overflow-y-auto bg-base-100 px-2 py-2 flex flex-col gap-2 [&>*]:shrink-0 transition-transform duration-300 ease-out"
			style="transform: translateX({sidebarOpen ? '0' : '100%'})"
		>
		<SidebarPanel
			keys={modelsData.keys}
				tasks={tabStore.activeTab?.tasks ?? []}
				cacheStats={tabStore.activeTab?.cacheStats ?? null}
				cacheTabTitle={tabStore.activeTab?.title ?? null}
				{contextLimit}
				permissionLog={tabStore.permissionLog}
				apiBase={config.apiBase}
				activeKeyId={tabStore.activeTab?.keyId ?? null}
				activeModelId={tabStore.activeTab?.modelId ?? null}
				reasoningEffort={tabStore.activeTab?.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
				activeAgentSlug={tabStore.activeTab?.agentSlug ?? null}
				activeTabParentId={tabStore.activeTab?.parentTabId ?? null}
				activeAgentModels={tabStore.activeTab?.agentModels ?? null}
				workingDirectory={tabStore.activeTab?.workingDirectory ?? null}
				onKeyChange={(keyId) => tabStore.setKey(keyId)}
				onModelChange={(keyId, modelId) => tabStore.changeModel(keyId, modelId)}
				onReasoningChange={(effort) => tabStore.setReasoningEffort(effort)}
				onAgentChange={(agent) => tabStore.setAgent(agent)}
				onWorkingDirectoryChange={(dir) => tabStore.setWorkingDirectory(dir)}
				onCompact={() => { const id = tabStore.activeTab?.id; if (id) void tabStore.startCompaction(id); }}
				canCompact={(tabStore.activeTab?.agentStatus ?? "idle") === "idle" && (tabStore.activeTab?.chunks.length ?? 0) > 0 && !(tabStore.activeTab?.compactingSource) && !(tabStore.activeTab?.isCompacting)}
				compacting={tabStore.activeTab?.isCompacting ?? false}
			onAddKey={() => { showAddKeyModal = true; addKeyId = ""; addKeyProvider = "anthropic"; addKeyError = null; }}
			/>
		</div>
		</div>
	</div>
	{:else if router.page === "agent-builder"}
	<AgentBuilder keys={modelsData.keys} />
	{/if}
</div>

<!-- Backdrop for sidebar on small screens -->
{#if sidebarOpen}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 bg-black/30 z-20 sm:hidden"
		role="button"
		tabindex="0"
		onclick={() => sidebarOpen = false}
		onkeydown={(e) => { if (e.key === 'Escape' || e.key === 'Enter') sidebarOpen = false; }}
		aria-label="Close sidebar"
	></div>
{/if}

<!-- Fixed overlay elements -->
<PermissionPrompt
	pending={tabStore.pendingPermissions}
	onReply={(id, reply) => tabStore.replyPermission(id, reply)}
/>

<!-- Hot reload indicator fixed top-right -->
<div class="fixed top-4 right-4 z-50">
	<HotReloadIndicator active={tabStore.configReloaded} />
</div>

<!-- Add New Key Modal (page-level to escape sidebar transform) -->
{#if showAddKeyModal}
	<div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog">
		<div class="bg-base-100 rounded-lg p-4 w-80 flex flex-col gap-3 shadow-xl">
			<h3 class="text-sm font-semibold">Add New Key</h3>
			<div class="flex flex-col gap-1">
				<label class="text-xs text-base-content/60" for="add-key-provider">Provider</label>
				<select id="add-key-provider" class="select select-bordered select-sm w-full" bind:value={addKeyProvider}>
					<option value="anthropic">Anthropic</option>
					<option value="opencode-go">OpenCode</option>
					<option value="google">Google (Gemini)</option>
				</select>
			</div>
			<div class="flex flex-col gap-1">
				<label class="text-xs text-base-content/60" for="add-key-id">Key ID</label>
				<input
					id="add-key-id"
					type="text"
					class="input input-bordered input-sm w-full"
					placeholder="e.g. claude-max, copilot-2"
					bind:value={addKeyId}
				/>
				<p class="text-xs text-base-content/40">Unique identifier for this key</p>
			</div>
			{#if addKeyError}
				<p class="text-xs text-error">{addKeyError}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button type="button" class="btn btn-sm btn-ghost"
					onclick={() => { showAddKeyModal = false; }}>
					Cancel
				</button>
				<button type="button" class="btn btn-sm btn-primary"
					disabled={!addKeyId.trim() || addKeySaving}
					onclick={addNewKey}>
					{#if addKeySaving}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Add Key
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
