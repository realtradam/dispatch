<script lang="ts">
import type { CacheStats } from "../types.js";

const {
	cacheStats = null,
	tabTitle = null,
}: {
	cacheStats?: CacheStats | null;
	tabTitle?: string | null;
} = $props();

// Cache hit rate = cached-read tokens / total prompt tokens. `inputTokens` is
// the TOTAL prompt (fresh + cache read + cache write), so this is the share of
// the prompt that was served from Anthropic's prompt cache.
function rate(read: number, totalInput: number): number {
	if (totalInput <= 0) return 0;
	return Math.max(0, Math.min(1, read / totalInput));
}

// For caching, a HIGH hit rate is GOOD — invert the usual color thresholds.
function rateClass(r: number): string {
	if (r >= 0.7) return "progress-success";
	if (r >= 0.3) return "progress-warning";
	return "progress-error";
}

function fmt(n: number): string {
	return n.toLocaleString();
}

const hitRate = $derived(cacheStats ? rate(cacheStats.cacheReadTokens, cacheStats.inputTokens) : 0);
const hitPct = $derived(Math.round(hitRate * 100));
const uncached = $derived(
	cacheStats
		? Math.max(0, cacheStats.inputTokens - cacheStats.cacheReadTokens - cacheStats.cacheWriteTokens)
		: 0,
);
const lastHitPct = $derived(
	cacheStats?.last
		? Math.round(rate(cacheStats.last.cacheReadTokens, cacheStats.last.inputTokens) * 100)
		: 0,
);
</script>

<div class="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto">
	{#if !cacheStats || cacheStats.requests === 0}
		<p class="text-xs text-base-content/50">
			No cache data yet. Send a message to a Claude model — prompt-cache usage
			appears here after the first response.
		</p>
	{:else}
		<div class="bg-base-200 rounded-lg p-2">
			<div class="flex items-center gap-1.5 mb-2">
				<span class="text-xs font-semibold">Cache Hit Rate</span>
				{#if tabTitle}
					<span class="badge badge-xs badge-ghost">{tabTitle}</span>
				{/if}
				<span class="badge badge-xs ml-auto whitespace-nowrap">{cacheStats.requests} req</span>
			</div>

			<!-- Headline cumulative hit rate -->
			<div class="flex flex-col gap-0.5">
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">Session (this tab)</span>
					<span class="text-xs font-mono">{hitPct}%</span>
				</div>
				<progress
					class="progress w-full h-2 {rateClass(hitRate)}"
					value={hitPct}
					max="100"
				></progress>
			</div>

			<!-- Most recent request -->
			{#if cacheStats.last}
				<div class="flex flex-col gap-0.5 mt-2">
					<div class="flex items-center justify-between">
						<span class="text-xs text-base-content/50">Last request</span>
						<span class="text-xs font-mono">{lastHitPct}%</span>
					</div>
					<progress
						class="progress w-full h-2 {rateClass(lastHitPct / 100)}"
						value={lastHitPct}
						max="100"
					></progress>
				</div>
			{/if}
		</div>

		<!-- Token breakdown (cumulative, this tab) -->
		<div class="bg-base-200 rounded-lg p-2">
			<div class="text-xs font-semibold mb-1.5">Tokens (cumulative)</div>
			<div class="flex flex-col gap-1 pl-1">
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">
						<span class="badge badge-xs badge-success badge-soft mr-1">read</span>Cache hits
					</span>
					<span class="text-xs font-mono">{fmt(cacheStats.cacheReadTokens)}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">
						<span class="badge badge-xs badge-warning badge-soft mr-1">write</span>Cache writes
					</span>
					<span class="text-xs font-mono">{fmt(cacheStats.cacheWriteTokens)}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">
						<span class="badge badge-xs badge-error badge-soft mr-1">fresh</span>Uncached input
					</span>
					<span class="text-xs font-mono">{fmt(uncached)}</span>
				</div>
				<div class="border-t border-base-300 my-0.5"></div>
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">Total input</span>
					<span class="text-xs font-mono">{fmt(cacheStats.inputTokens)}</span>
				</div>
				<div class="flex items-center justify-between">
					<span class="text-xs text-base-content/50">Output</span>
					<span class="text-xs font-mono">{fmt(cacheStats.outputTokens)}</span>
				</div>
			</div>
		</div>
	{/if}
</div>
