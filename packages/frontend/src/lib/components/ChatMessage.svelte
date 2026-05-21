<script lang="ts">
import type { ChatMessage } from "../types.js";
import { appSettings } from "../settings.svelte.js";
import MarkdownRenderer from "./MarkdownRenderer.svelte";
import ToolCallDisplay from "./ToolCallDisplay.svelte";

const { message }: { message: ChatMessage } = $props();

const isUser = $derived(message.role === "user");
const isSystem = $derived(message.role === "system");
</script>

{#if isSystem}
	<div class="flex justify-center my-2">
		<div class="badge badge-ghost gap-1 text-xs opacity-60">
			{#each message.content as segment}
				{#if segment.type === "text"}
					{segment.text}
				{/if}
			{/each}
		</div>
	</div>
{:else}
<div class="chat chat-start mb-2">
	<div class="chat-bubble max-w-[80%] break-words {isUser ? 'chat-bubble-primary' : 'bg-transparent'}">
		{#if message.thinking}
			<div class="collapse collapse-arrow mb-2 p-1">
				<input type="checkbox" checked={appSettings.autoExpandThinking} />
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
			<span class="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-middle rounded-sm"></span>
		{/if}
	</div>
</div>
{/if}
