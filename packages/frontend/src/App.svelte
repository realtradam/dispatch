<script lang="ts">
import { onMount } from "svelte";
import ChatInput from "./lib/components/ChatInput.svelte";
import ChatPanel from "./lib/components/ChatPanel.svelte";
import Header from "./lib/components/Header.svelte";
import PermissionPrompt from "./lib/components/PermissionPrompt.svelte";
import PermissionLog from "./lib/components/PermissionLog.svelte";
import { chatStore } from "./lib/chat.svelte.js";
import { wsClient } from "./lib/ws.svelte.js";

const STORAGE_KEY = "dispatch-theme";

onMount(() => {
	// Apply saved theme
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) {
		document.documentElement.setAttribute("data-theme", saved);
	}

	// Connect WebSocket
	wsClient.connect();

	return () => {
		wsClient.disconnect();
	};
});
</script>

<div class="flex flex-col h-screen overflow-hidden bg-base-100 text-base-content">
	<Header />
	<div class="flex-1 overflow-hidden">
		<ChatPanel />
	</div>
	<ChatInput />
</div>

<PermissionPrompt
	pending={chatStore.pendingPermissions}
	onReply={(id, reply) => chatStore.replyPermission(id, reply)}
/>

<div class="fixed bottom-24 right-4 w-80 z-10">
	<PermissionLog entries={chatStore.permissionLog} />
</div>
