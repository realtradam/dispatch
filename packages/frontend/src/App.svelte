<script lang="ts">
import { onMount } from "svelte";
import ChatInput from "./lib/components/ChatInput.svelte";
import ChatPanel from "./lib/components/ChatPanel.svelte";
import Header from "./lib/components/Header.svelte";
import PermissionPrompt from "./lib/components/PermissionPrompt.svelte";
import PermissionLog from "./lib/components/PermissionLog.svelte";
import ConfigPanel from "./lib/components/ConfigPanel.svelte";
import SkillsBrowser from "./lib/components/SkillsBrowser.svelte";
import TaskListPanel from "./lib/components/TaskListPanel.svelte";
import ModelStatus from "./lib/components/ModelStatus.svelte";
import HotReloadIndicator from "./lib/components/HotReloadIndicator.svelte";
import { chatStore } from "./lib/chat.svelte.js";
import { wsClient } from "./lib/ws.svelte.js";
import { config } from "./lib/config.js";

const STORAGE_KEY = "dispatch-theme";

interface KeyInfo {
	id: string;
	provider: string;
	status: "active" | "exhausted";
	lastError: string | null;
	exhaustedAt: number | null;
}

interface ModelInfo {
	id: string;
	provider: string;
	tags: string[];
}

let modelsData = $state<{ models: ModelInfo[]; keys: KeyInfo[]; tags: string[] }>({
	models: [],
	keys: [],
	tags: [],
});

let sidebarOpen = $state(true);

async function fetchModels() {
	try {
		const res = await fetch(`${config.apiBase}/models`);
		if (!res.ok) return;
		const data = await res.json();
		modelsData = {
			models: data.models ?? [],
			keys: data.keys ?? [],
			tags: data.tags ? (Array.isArray(data.tags) ? data.tags : Object.keys(data.tags)) : [],
		};
	} catch {
		// ignore fetch errors
	}
}

$effect(() => {
	if (chatStore.configReloaded) {
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
			<div class="flex-1 overflow-hidden">
				<ChatPanel />
			</div>
			<ChatInput />
		</div>

		<!-- Right sidebar — slides in/out while chat smoothly resizes -->
		<div
			class="shrink-0 overflow-x-hidden transition-[width] duration-300 ease-out relative"
			class:w-80={sidebarOpen}
			class:w-0={!sidebarOpen}
		>
			<div
				class="w-80 absolute inset-0 overflow-y-auto bg-base-100 border-l border-base-300 px-2 py-2 flex flex-col gap-2 transition-transform duration-300 ease-out"
				style="transform: translateX({sidebarOpen ? '0' : '100%'})"
			>
				<div class="collapse collapse-arrow bg-base-200">
					<input type="checkbox" checked />
					<div class="collapse-title text-sm font-medium">Model Status</div>
					<div class="collapse-content">
						<ModelStatus
							models={modelsData.models}
							keys={modelsData.keys}
							tags={modelsData.tags}
						/>
					</div>
				</div>

				<div class="collapse collapse-arrow bg-base-200">
					<input type="checkbox" checked />
					<div class="collapse-title text-sm font-medium">Tasks</div>
					<div class="collapse-content">
						<TaskListPanel tasks={chatStore.tasks} />
					</div>
				</div>

				<ConfigPanel apiBase={config.apiBase} />

				<SkillsBrowser apiBase={config.apiBase} />

				<PermissionLog entries={chatStore.permissionLog} />
			</div>
		</div>
	</div>
</div>

<!-- Fixed overlay elements -->
<PermissionPrompt
	pending={chatStore.pendingPermissions}
	onReply={(id, reply) => chatStore.replyPermission(id, reply)}
/>

<!-- Hot reload indicator fixed top-right -->
<div class="fixed top-4 right-4 z-50">
	<HotReloadIndicator active={chatStore.configReloaded} />
</div>
