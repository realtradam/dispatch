<script lang="ts">
import { onMount } from "svelte";
import ChatInput from "./lib/components/ChatInput.svelte";
import ChatPanel from "./lib/components/ChatPanel.svelte";
import Header from "./lib/components/Header.svelte";
import TabBar from "./lib/components/TabBar.svelte";
import PermissionPrompt from "./lib/components/PermissionPrompt.svelte";
import SidebarPanel from "./lib/components/SidebarPanel.svelte";
import HotReloadIndicator from "./lib/components/HotReloadIndicator.svelte";
import { tabStore } from "./lib/tabs.svelte.js";
import { wsClient } from "./lib/ws.svelte.js";
import { config } from "./lib/config.js";
import type { KeyInfo } from "./lib/types.js";

const STORAGE_KEY = "dispatch-theme";

let modelsData = $state<{ keys: KeyInfo[] }>({
	keys: [],
});

let sidebarOpen = $state(true);

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

onMount(() => {
	// Apply saved theme
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) {
		document.documentElement.setAttribute("data-theme", saved);
	}

	// Connect WebSocket
	wsClient.connect();

	// Initial models fetch
	fetchModels();

	// Create initial tab
	if (tabStore.tabs.length === 0) {
		tabStore.createNewTab();
	}

	return () => {
		wsClient.disconnect();
	};
});
</script>

<div class="flex flex-col h-screen overflow-hidden">
	<Header onToggleSidebar={() => sidebarOpen = !sidebarOpen} />

	<div class="flex flex-1 overflow-hidden">
		<!-- Main chat area -->
		<div class="flex flex-col flex-1 min-w-0 overflow-hidden">
			<TabBar />
			<div class="flex-1 overflow-hidden">
				<ChatPanel />
			</div>
			<ChatInput />
		</div>

		<!-- Right sidebar -->
		<div
			class="shrink-0 overflow-x-hidden flex flex-col transition-[width] duration-300 ease-out relative"
			class:w-80={sidebarOpen}
			class:w-0={!sidebarOpen}
		>
		<div
			class="w-80 flex-1 min-h-0 overflow-y-auto bg-base-100 border-l border-base-300 px-2 py-2 flex flex-col gap-2 [&>*]:shrink-0 transition-transform duration-300 ease-out"
			style="transform: translateX({sidebarOpen ? '0' : '100%'})"
		>
		<SidebarPanel
			keys={modelsData.keys}
				tasks={tabStore.activeTab?.tasks ?? []}
				permissionLog={tabStore.permissionLog}
				apiBase={config.apiBase}
				activeKeyId={tabStore.activeTab?.keyId ?? null}
				activeModelId={tabStore.activeTab?.modelId ?? null}
				reasoningEffort={tabStore.activeTab?.reasoningEffort ?? "max"}
				onKeyChange={(keyId) => tabStore.setKey(keyId)}
				onModelChange={(keyId, modelId) => tabStore.changeModel(keyId, modelId)}
				onReasoningChange={(effort) => {
					const tab = tabStore.activeTab;
					if (tab) {
						// Update reasoning effort for active tab
						tabStore.tabs.find(t => t.id === tab.id)!.reasoningEffort = effort;
					}
				}}
			/>
		</div>
		</div>
	</div>
</div>

<!-- Fixed overlay elements -->
<PermissionPrompt
	pending={tabStore.pendingPermissions}
	onReply={(id, reply) => tabStore.replyPermission(id, reply)}
/>

<!-- Hot reload indicator fixed top-right -->
<div class="fixed top-4 right-4 z-50">
	<HotReloadIndicator active={tabStore.configReloaded} />
</div>
