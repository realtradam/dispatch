<script lang="ts">
import { chatStore } from "../chat.svelte.js";
import { wsClient } from "../ws.svelte.js";
import ChatMessageComponent from "./ChatMessage.svelte";

let messagesEl: HTMLDivElement | undefined;

const statusColor = $derived(
	wsClient.connectionStatus === "connected"
		? "bg-success"
		: wsClient.connectionStatus === "connecting"
			? "bg-warning"
			: "bg-error",
);

$effect(() => {
	// Trigger on messages change to scroll
	void chatStore.messages;
	if (messagesEl) {
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}
});
</script>

<div class="flex flex-col h-full">
	<!-- Status bar -->
	<div class="flex items-center gap-3 px-4 py-2 bg-base-200 border-b border-base-300 text-xs">
		<span class="flex items-center gap-1.5">
			<span class="w-2 h-2 rounded-full {statusColor}"></span>
			<span class="capitalize text-base-content/70">{wsClient.connectionStatus}</span>
		</span>
		<span class="text-base-content/50">|</span>
		<span class="text-base-content/70">
			Agent:
			<span
				class="font-semibold {chatStore.agentStatus === 'running'
					? 'text-warning'
					: chatStore.agentStatus === 'error'
						? 'text-error'
						: 'text-success'}"
			>
				{chatStore.agentStatus === "running" ? "running..." : chatStore.agentStatus}
			</span>
		</span>
	</div>

	<!-- Messages -->
	<div bind:this={messagesEl} class="flex-1 overflow-y-auto p-4">
		{#if chatStore.messages.length === 0}
			<div class="flex items-center justify-center h-full text-base-content/40 text-sm">
				Send a message to start a conversation
			</div>
		{/if}
		{#each chatStore.messages as message (message.id)}
			<ChatMessageComponent {message} />
		{/each}
	</div>
</div>
