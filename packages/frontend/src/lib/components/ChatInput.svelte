<script lang="ts">
import { tabStore } from "../tabs.svelte.js";

let inputEl: HTMLInputElement | undefined;
let inputValue = $state("");
const isDisabled = $derived((tabStore.activeTab?.agentStatus ?? "idle") === "running");

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
	if (!text || isDisabled) return;
	inputValue = "";
	tabStore.sendMessage(text);
}
</script>

<div class="flex items-center gap-2 p-3">
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
		disabled={isDisabled || !inputValue.trim()}
		onclick={submit}
	>
		Send
	</button>
</div>
