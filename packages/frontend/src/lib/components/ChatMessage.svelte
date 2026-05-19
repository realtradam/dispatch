<script lang="ts">
import type { ChatMessage } from "../types.js";
import ToolCallDisplay from "./ToolCallDisplay.svelte";

const { message }: { message: ChatMessage } = $props();

const isUser = $derived(message.role === "user");
</script>

<div class="chat {isUser ? 'chat-end' : 'chat-start'} mb-2">
	<div class="chat-bubble {isUser ? 'chat-bubble-primary' : 'chat-bubble-secondary'} max-w-[80%] break-words">
		{#if message.thinking}
			<details class="mb-2">
				<summary class="cursor-pointer text-sm text-base-content/60 italic">Thinking...</summary>
				<p class="text-sm text-base-content/60 italic mt-1 whitespace-pre-wrap">{message.thinking}</p>
			</details>
		{/if}
		{#each message.content as segment, i (segment.type === "tool-call" ? segment.id : i)}
			{#if segment.type === "text"}
				<span>{segment.text}</span>
			{:else if segment.type === "tool-call"}
				<ToolCallDisplay toolCall={segment} />
			{/if}
		{/each}
		{#if message.isStreaming}
			<span class="inline-block w-2 h-4 bg-current animate-pulse ml-0.5 align-middle">▌</span>
		{/if}
	</div>
</div>
