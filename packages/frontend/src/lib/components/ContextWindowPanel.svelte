<script lang="ts">
import { computeContextUsage } from "../context-window.js";
import type { CacheStats } from "../types.js";

const {
	cacheStats = null,
	contextLimit = null,
	tabTitle = null,
	modelId = null,
}: {
	cacheStats?: CacheStats | null;
	contextLimit?: number | null;
	tabTitle?: string | null;
	modelId?: string | null;
} = $props();

const usage = $derived(computeContextUsage(cacheStats, contextLimit));

// As the window fills, escalate color: calm → warning → danger.
function fillClass(pct: number): string {
	if (pct >= 90) return "progress-error";
	if (pct >= 70) return "progress-warning";
	return "progress-success";
}

function fmt(n: number): string {
	return n.toLocaleString();
}

const hasUsage = $derived((cacheStats?.last ?? null) !== null);
</script>

<div class="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
	{#if !hasUsage}
		<p class="text-xs text-base-content/50">
			No context data yet. Send a message — the current context size appears
			here after the first response.
		</p>
	{:else}
		<div class="bg-base-200 rounded-lg p-2">
			<div class="flex items-center gap-1.5 mb-2">
				<span class="text-xs font-semibold">Context Window</span>
				{#if tabTitle}
					<span class="badge badge-xs badge-ghost">{tabTitle}</span>
				{/if}
				{#if usage.percent !== null}
					<span class="badge badge-xs ml-auto">{usage.percent.toFixed(2)}%</span>
				{/if}
			</div>

			<!-- Headline: current / max (or just current when max is unknown) -->
			<div class="flex items-baseline gap-1.5">
				<span class="text-lg font-mono font-semibold">{fmt(usage.current)}</span>
				{#if usage.max !== null}
					<span class="text-xs text-base-content/50 font-mono">/ {fmt(usage.max)}</span>
				{/if}
				<span class="text-xs text-base-content/40 ml-1">tokens</span>
			</div>

			{#if usage.percent !== null}
				<progress
					class="progress w-full h-2 mt-1.5 {fillClass(usage.percent)}"
					value={usage.percent}
					max="100"
				></progress>
			{:else}
				<p class="text-xs text-base-content/40 mt-1.5">
					Max context size unknown for this model.
				</p>
			{/if}

			{#if modelId}
				<div class="text-xs text-base-content/40 mt-1.5 truncate" title={modelId}>
					{modelId}
				</div>
			{/if}
		</div>

		<p class="text-xs text-base-content/40">
			Current context = the most recent request's prompt + output (what the
			model actually held in its window that turn). Grows as the conversation
			gets longer. Resets on reload.
		</p>
	{/if}
</div>
