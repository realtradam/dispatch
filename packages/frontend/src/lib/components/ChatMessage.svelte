<script lang="ts">
import type { ChatMessage } from "../types.js";
import ToolCallDisplay from "./ToolCallDisplay.svelte";

const { message }: { message: ChatMessage } = $props();

const isUser = $derived(message.role === "user");
</script>

<div class="chat {isUser ? 'chat-end' : 'chat-start'} mb-2">
	<div class="chat-bubble {isUser ? 'chat-bubble-primary' : 'chat-bubble-secondary'} max-w-[80%] break-words">
		{#if message.content}
			<span>{message.content}</span>
		{/if}
		{#if message.isStreaming}
			<span class="inline-block w-2 h-4 bg-current animate-pulse ml-0.5 align-middle">▌</span>
		{/if}
		{#if message.toolCalls && message.toolCalls.length > 0}
			<div class="mt-2">
				{#each message.toolCalls as toolCall (toolCall.id)}
					<ToolCallDisplay {toolCall} />
				{/each}
			</div>
		{/if}
	</div>
</div>
