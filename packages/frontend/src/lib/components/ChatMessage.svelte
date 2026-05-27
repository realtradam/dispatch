<script lang="ts">
import { appSettings } from "../settings.svelte.js";
import { tabStore } from "../tabs.svelte.js";
import type { ChatMessage, Chunk, SystemChunkKind } from "../types.js";
import MarkdownRenderer from "./MarkdownRenderer.svelte";
import ToolCallDisplay from "./ToolCallDisplay.svelte";

const { message, tabId }: { message: ChatMessage; tabId?: string } = $props();

const isUser = $derived(message.role === "user");
const isSystem = $derived(message.role === "system");

// Check if this message is queued: its id starts with "queued-"
const queuedMessageId = $derived(
	isUser && message.id.startsWith("queued-") ? message.id.slice("queued-".length) : null,
);
const isQueued = $derived(queuedMessageId !== null);

function cancelQueued() {
	if (tabId && queuedMessageId) {
		void tabStore.cancelQueuedMessage(tabId, queuedMessageId);
	}
}

function chunkKey(chunk: Chunk, i: number): string {
	if (chunk.type === "tool-batch") {
		// Stable-ish: first call id + count keeps re-renders sane while streaming.
		return `tb-${chunk.calls[0]?.id ?? i}-${chunk.calls.length}`;
	}
	return `${chunk.type}-${i}`;
}

const SYSTEM_KIND_LABEL: Record<SystemChunkKind, string> = {
	notice: "Notice",
	"model-changed": "Model changed",
	"config-reload": "Config reload",
	cancelled: "Cancelled",
};

/**
 * Returns true if the given chunk has visible content worth rendering.
 * Used by `hasRenderableContent` to suppress empty assistant bubbles.
 *
 * Note: `ThinkingChunk.metadata` is intentionally excluded — it is
 * internal wire data (Anthropic's providerMetadata / signature) and
 * must never appear in the UI.
 */
function chunkHasRenderableContent(chunk: Chunk): boolean {
	switch (chunk.type) {
		case "text":
			return chunk.text.length > 0;
		case "thinking":
			return chunk.text.length > 0;
		case "tool-batch":
			return chunk.calls.length > 0;
		case "error":
			return true;
		case "system":
			return true;
	}
}

/**
 * True when the assistant bubble has something worth showing.
 * Guards the assistant render path so we don't emit an empty box
 * (e.g. a message that only had empty/signature-only thinking blocks
 * from Anthropic adaptive thinking mode).
 *
 * Streaming messages always have renderable content — the cursor
 * needs somewhere to live.
 */
const hasRenderableContent = $derived(
	message.isStreaming === true || message.chunks.some(chunkHasRenderableContent),
);
</script>

{#snippet renderChunks(chunks: Chunk[], streaming: boolean | undefined)}
	{#each chunks as chunk, i (chunkKey(chunk, i))}
		{#if chunk.type === "text"}
			<MarkdownRenderer text={chunk.text} {streaming} />
		{:else if chunk.type === "thinking"}
			<!-- Skip empty thinking chunks: Anthropic adaptive thinking can emit
			     a reasoning-end with a signature but no thinking_delta content.
			     The metadata is internal wire data — never displayed. -->
			{#if chunk.text.length > 0}
				<div class="collapse collapse-arrow mb-2 p-1">
					<input type="checkbox" checked={appSettings.autoExpandThinking} />
					<div class="collapse-title text-sm opacity-60 italic py-0 pl-0 pr-8 min-h-0">Thinking...</div>
					<div class="collapse-content text-sm opacity-60 italic p-0">
						<p class="whitespace-pre-wrap mt-1">{chunk.text}</p>
					</div>
				</div>
			{/if}
		{:else if chunk.type === "tool-batch"}
			{#each chunk.calls as call (call.id)}
				<ToolCallDisplay toolCall={call} />
			{/each}
		{:else if chunk.type === "error"}
			<div class="alert alert-error my-2 py-2 px-3 text-sm rounded border border-error/60 bg-error/10 text-error">
				<div class="flex flex-col gap-0.5 w-full">
					<span class="break-words">{chunk.message}</span>
					{#if chunk.statusCode !== undefined}
						<span class="text-xs opacity-70">status {chunk.statusCode}</span>
					{/if}
				</div>
			</div>
		{:else if chunk.type === "system"}
			<div class="my-1 text-xs italic opacity-50 flex gap-1 items-baseline">
				<span class="font-semibold not-italic">{SYSTEM_KIND_LABEL[chunk.kind]}:</span>
				<span class="break-words">{chunk.text}</span>
			</div>
		{/if}
	{/each}
{/snippet}

{#if isSystem}
	<div class="flex justify-center my-2 px-4">
		<div class="max-w-full text-center">
			{@render renderChunks(message.chunks, false)}
		</div>
	</div>
{:else if !isUser && !hasRenderableContent}
	<!-- Empty assistant message — no renderable chunks and not streaming.
	     Suppressed to avoid an empty bubble (e.g. a turn that produced
	     only empty/signature-only thinking blocks from Anthropic adaptive
	     thinking mode, or a done event with no content). -->
{:else}
<div class="chat chat-start mb-2 [&>.chat-bubble]:max-w-full {isQueued ? 'opacity-60' : ''}">
	<div class="chat-bubble break-words {isUser ? 'chat-bubble-primary w-fit' : 'bg-transparent w-full'}">
		{@render renderChunks(message.chunks, message.isStreaming)}
		{#if message.isStreaming}
			<span class="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 align-middle rounded-sm"></span>
		{/if}
	</div>
	{#if isQueued}
		<div class="flex items-center gap-1 mt-0.5 ml-1">
			<span class="badge badge-ghost badge-xs text-base-content/40">queued</span>
			<button
				class="btn btn-xs btn-ghost text-base-content/40 hover:text-error px-1 min-h-0 h-auto"
				onclick={cancelQueued}
				title="Cancel queued message"
			>
				✕
			</button>
		</div>
	{/if}
</div>
{/if}
