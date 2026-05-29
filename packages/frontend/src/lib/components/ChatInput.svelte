<script lang="ts">
import { tabStore } from "../tabs.svelte.js";

let inputEl: HTMLInputElement | undefined;
let inputValue = $state("");

const agentStatus = $derived(tabStore.activeTab?.agentStatus ?? "idle");
const tabId = $derived(tabStore.activeTab?.id ?? "");

$effect(() => {
	inputEl?.focus();
});

function handleKeydown(e: KeyboardEvent) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		submit();
	}
}

function submit() {
	const text = inputValue.trim();
	if (!text) return;
	inputValue = "";
	tabStore.sendMessage(text);
}
</script>

<div class="flex items-center gap-2 p-3">
	{#if agentStatus === "running"}
		<button
			type="button"
			class="btn btn-ghost gap-1 btn-sm lg:btn-xs"
			onclick={() => tabStore.stopGeneration(tabId)}
			title="Stop generation"
		>
			<span class="loading loading-spinner loading-sm text-primary"></span>
			<span class="text-xs">Stop</span>
		</button>
	{:else if agentStatus === "idle"}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 text-success">
			<polyline points="20 6 9 17 4 12"></polyline>
		</svg>
	{:else if agentStatus === "error"}
		<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-5 h-5 text-error">
			<circle cx="12" cy="12" r="10"></circle>
			<line x1="12" y1="8" x2="12" y2="12"></line>
			<line x1="12" y1="16" x2="12.01" y2="16"></line>
		</svg>
	{/if}
	<input
		bind:this={inputEl}
		bind:value={inputValue}
		type="text"
		placeholder="Type a message..."
		class="input input-ghost flex-1"
		onkeydown={handleKeydown}
	/>
	<button
		type="button"
		class="btn btn-primary"
		disabled={!inputValue.trim()}
		onclick={submit}
	>
		Send
	</button>
</div>
