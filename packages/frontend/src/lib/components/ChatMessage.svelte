<script lang="ts">
import type { ChatMessage } from "../types.js";
import MarkdownRenderer from "./MarkdownRenderer.svelte";
import ToolCallDisplay from "./ToolCallDisplay.svelte";

const { message }: { message: ChatMessage } = $props();

const isUser = $derived(message.role === "user");
</script>

<div class="chat chat-start mb-2">
	<div class="chat-bubble {isUser ? 'chat-bubble-primary' : 'chat-bubble-secondary'} max-w-[80%] break-words">
		{#if message.thinking}
			<div class="collapse collapse-arrow mb-2 p-1">
				<input type="checkbox" />
				<div class="collapse-title text-sm opacity-60 italic py-0 pl-0 pr-8 min-h-0">Thinking...</div>
				<div class="collapse-content text-sm opacity-60 italic p-0">
					<p class="whitespace-pre-wrap mt-1">{message.thinking}</p>
				</div>
			</div>
		{/if}
		{#each message.content as segment, i (segment.type === "tool-call" ? segment.id : i)}
			{#if segment.type === "text"}
				<MarkdownRenderer text={segment.text} streaming={message.isStreaming} />
			{:else if segment.type === "tool-call"}
				<ToolCallDisplay toolCall={segment} />
			{/if}
		{/each}
		{#if message.isStreaming}
			<span class="inline-block w-2 h-4 bg-current animate-pulse ml-0.5 align-middle">▌</span>
		{/if}
	</div>
</div>
