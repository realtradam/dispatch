<script lang="ts">
import { computeContextUsage } from "../context-window.js";
import { tabStore } from "../tabs.svelte.js";

const { contextLimit = null }: { contextLimit?: number | null } = $props();

const MAX_LINES = 7;

let inputEl: HTMLTextAreaElement | undefined;

const agentStatus = $derived(tabStore.activeTab?.agentStatus ?? "idle");
const tabId = $derived(tabStore.activeTab?.id ?? "");
// The current input text lives on the active tab (in-memory draft), so
// switching tabs saves the current draft and restores the target tab's text
// automatically — drafts are never lost or clobbered by tab switching.
const inputValue = $derived(tabStore.activeTab?.draft ?? "");
const cacheStats = $derived(tabStore.activeTab?.cacheStats ?? null);

const isRunning = $derived(agentStatus === "running");
const hasText = $derived(inputValue.trim().length > 0);
// While generating with an empty box, the primary action is "stop". With text
// in the box, it stays "send" (the message is queued behind the live turn).
const showStop = $derived(isRunning && !hasText);

const usage = $derived(computeContextUsage(cacheStats, contextLimit));
const hasUsage = $derived((cacheStats?.last ?? null) !== null);

// As the window fills, escalate color: calm → warning → danger. Mirrors the
// Context Window sidebar view so the two displays agree.
function fillClass(pct: number): string {
	if (pct >= 90) return "progress-error";
	if (pct >= 70) return "progress-warning";
	return "progress-success";
}

// Compact token count for the slim bar (e.g. 12.3k, 1.2M). Full numbers live
// in the sidebar's Context Window panel.
function fmtCompact(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) {
		const k = n / 1000;
		return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
	}
	const m = n / 1_000_000;
	return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}

$effect(() => {
	// Re-focus when switching tabs.
	void tabId;
	inputEl?.focus();
});

function resize() {
	const el = inputEl;
	if (!el) return;
	// Reset height so scrollHeight reflects the content's natural height.
	el.style.height = "auto";
	const style = getComputedStyle(el);
	const lineHeight = Number.parseFloat(style.lineHeight) || 20;
	const paddingY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
	const borderY =
		Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
	const maxHeight = lineHeight * MAX_LINES + paddingY + borderY;
	const next = Math.min(el.scrollHeight, maxHeight);
	el.style.height = `${next}px`;
	el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
}

// Re-run resize whenever the value changes (covers tab switches and
// programmatic clears too).
$effect(() => {
	// Touch inputValue so this effect tracks it.
	void inputValue;
	resize();
});

function handleInput(e: Event) {
	if (!tabId) return;
	tabStore.setDraft(tabId, (e.currentTarget as HTMLTextAreaElement).value);
}

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
}

function submit() {
	const text = inputValue.trim();
	if (!text) return;
	if (tabId) tabStore.setDraft(tabId, "");
	tabStore.sendMessage(text);
}

function primaryAction() {
	if (showStop) {
		tabStore.stopGeneration(tabId);
		return;
	}
	submit();
}
</script>

<div class="flex flex-col">
	<!-- Top bar: expanding textarea + send/stop action -->
	<div class="flex items-end gap-2 px-3 pt-3 pb-2">
		<textarea
			bind:this={inputEl}
			value={inputValue}
			rows="1"
			placeholder="Type a message..."
			class="textarea textarea-ghost flex-1 resize-none leading-normal !min-h-0 h-auto"
			onkeydown={handleKeydown}
			oninput={handleInput}
		></textarea>
		<!-- Single fixed-width button across all states so the layout never
		     shifts when it morphs between Send and Stop. -->
		<button
			type="button"
			class="btn w-20 shrink-0 {showStop ? 'btn-error btn-outline' : 'btn-primary'}"
			disabled={!showStop && !hasText}
			onclick={primaryAction}
			title={showStop ? "Stop generation" : "Send message"}
		>
			{#if showStop}
				<span class="loading loading-spinner loading-sm"></span>
				Stop
			{:else}
				Send
			{/if}
		</button>
	</div>

	<!-- Bottom bar: status icon · context progress · token count -->
	<div class="flex items-center gap-2 px-3 pb-2 text-xs text-base-content/50">
		<!-- Status icon -->
		<span class="shrink-0">
			{#if agentStatus === "running"}
				<span class="loading loading-spinner loading-xs text-primary"></span>
			{:else if agentStatus === "error"}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 text-error" aria-label="Error">
					<circle cx="12" cy="12" r="10"></circle>
					<line x1="12" y1="8" x2="12" y2="12"></line>
					<line x1="12" y1="16" x2="12.01" y2="16"></line>
				</svg>
			{:else}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 text-success" aria-label="Idle">
					<polyline points="20 6 9 17 4 12"></polyline>
				</svg>
			{/if}
		</span>

		<!-- Context-window fill bar -->
		{#if usage.percent !== null}
			<progress
				class="progress flex-1 h-2 {fillClass(usage.percent)}"
				value={usage.percent}
				max="100"
			></progress>
		{:else}
			<!-- Model's max context is unknown → inert, disabled bar. -->
			<progress class="progress flex-1 h-2 opacity-40" value="0" max="100"></progress>
		{/if}

		<!-- Context size + percent -->
		<span class="shrink-0 font-mono whitespace-nowrap">
			{#if hasUsage}
				{fmtCompact(usage.current)}{#if usage.max !== null}<span class="text-base-content/40"> / {fmtCompact(usage.max)}</span>{/if}
				{#if usage.percent !== null}
					<span class="ml-1">· {usage.percent.toFixed(1)}%</span>
				{/if}
			{:else}
				<span class="text-base-content/40">— tokens</span>
			{/if}
		</span>
	</div>
</div>
