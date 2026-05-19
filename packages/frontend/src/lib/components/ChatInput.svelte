<script lang="ts">
import { chatStore } from "../chat.svelte.js";

let inputEl: HTMLInputElement | undefined;
let inputValue = $state("");
const isDisabled = $derived(chatStore.agentStatus === "running");

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
	chatStore.sendMessage(text);
}
</script>

<div class="flex items-center gap-2 p-3 border-t border-base-300 bg-base-100">
	<input
		bind:this={inputEl}
		bind:value={inputValue}
		type="text"
		placeholder={isDisabled ? "Agent is running..." : "Type a message..."}
		class="input input-bordered flex-1"
		disabled={isDisabled}
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
