<script lang="ts">
import type { PermissionPrompt } from "../types.js";

const { pending, onReply }: {
	pending: PermissionPrompt[];
	onReply: (id: string, reply: "once" | "always" | "reject") => void;
} = $props();

let current = $derived(pending[0]);

let showAlwaysConfirmation = $state(false);

let dialogEl: HTMLDialogElement | undefined = $state();

$effect(() => {
	if (!dialogEl) return;
	if (current) {
		if (!dialogEl.open) dialogEl.showModal();
	} else {
		if (dialogEl.open) dialogEl.close();
	}
});

function handleAlways() {
	showAlwaysConfirmation = true;
}

function confirmAlways() {
	if (current) onReply(current.id, "always");
	showAlwaysConfirmation = false;
}

function handleOnce() {
	if (current) onReply(current.id, "once");
}

function handleReject() {
	showAlwaysConfirmation = false;
	if (current) onReply(current.id, "reject");
}
</script>

<dialog class="modal" bind:this={dialogEl} oncancel={handleReject}>
	{#if current}
		{#if !showAlwaysConfirmation}
			<div class="modal-box">
				<h3 class="text-lg font-bold">
					{#if current.permission === "bash"}
						Run command
					{:else if current.permission === "external_directory"}
						Access external directory
					{:else if current.permission === "read"}
						Read file
					{:else if current.permission === "edit"}
						Edit file
					{:else}
						Permission required
					{/if}
				</h3>

				<p class="py-2 text-sm opacity-70">{current.description}</p>

				{#if current.permission === "bash" && current.metadata.command}
					<div class="mockup-code my-2">
						<pre><code>$ {current.metadata.command as string}</code></pre>
					</div>
				{/if}

				{#if current.metadata.filepath}
					<p class="text-sm font-mono">{current.metadata.filepath as string}</p>
				{/if}

				<div class="modal-action gap-2">
					<button class="btn btn-sm btn-ghost" aria-label="Deny permission" onclick={handleReject}>Deny</button>
					<button class="btn btn-sm" aria-label="Allow once" onclick={handleOnce}>Allow once</button>
					<button class="btn btn-sm btn-primary" aria-label="Always allow" onclick={handleAlways}>Always allow</button>
				</div>
			</div>
		{:else}
			<div class="modal-box">
				<h3 class="text-lg font-bold">Always allow?</h3>
				<p class="py-2 text-sm">
					The following patterns will be permanently allowed until you restart Dispatch:
				</p>
				<div class="mockup-code my-2">
					{#each current.always as pattern}
						<pre><code>{pattern}</code></pre>
					{/each}
				</div>
				<div class="modal-action gap-2">
					<button class="btn btn-sm btn-ghost" aria-label="Go back" onclick={() => showAlwaysConfirmation = false}>Back</button>
					<button class="btn btn-sm btn-primary" aria-label="Confirm always allow" onclick={confirmAlways}>Confirm</button>
				</div>
			</div>
		{/if}
	{/if}
</dialog>
