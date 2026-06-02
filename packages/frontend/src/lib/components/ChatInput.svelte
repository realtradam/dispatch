<script lang="ts">
import { tabStore } from "../tabs.svelte.js";

const MAX_LINES = 7;

let inputEl: HTMLTextAreaElement | undefined;

const agentStatus = $derived(tabStore.activeTab?.agentStatus ?? "idle");
const tabId = $derived(tabStore.activeTab?.id ?? "");
// The current input text lives on the active tab (in-memory draft), so
// switching tabs saves the current draft and restores the target tab's text
// automatically — drafts are never lost or clobbered by tab switching.
const inputValue = $derived(tabStore.activeTab?.draft ?? "");

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
</script>

<div class="flex items-end gap-2 p-3">
	{#if agentStatus === "running"}
		<button
			type="button"
			class="btn btn-ghost gap-1 btn-sm lg:btn-xs"
			onclick={() => tabStore.stopGeneration(tabId)}
			title="Stop generation"
		>
			<span class="loading loading-spinner loading-sm text-primary" style="pointer-events: auto"></span>
			<span class="text-xs">Stop</span>
		</button>
	{:else if agentStatus === "idle"}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 text-success shrink-0 mb-2">
			<polyline points="20 6 9 17 4 12"></polyline>
		</svg>
	{:else if agentStatus === "error"}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 text-error shrink-0 mb-2">
			<circle cx="12" cy="12" r="10"></circle>
			<line x1="12" y1="8" x2="12" y2="12"></line>
			<line x1="12" y1="16" x2="12.01" y2="16"></line>
		</svg>
	{/if}
	<textarea
		bind:this={inputEl}
		value={inputValue}
		rows="1"
		placeholder="Type a message..."
		class="textarea textarea-ghost flex-1 resize-none leading-normal !min-h-0 h-auto"
		onkeydown={handleKeydown}
		oninput={handleInput}
	></textarea>
	<button
		type="button"
		class="btn btn-primary"
		disabled={!inputValue.trim()}
		onclick={submit}
	>
		Send
	</button>
</div>
