<script lang="ts">
import { tabStore } from "../tabs.svelte.js";

let copyLabel = $state("Copy conversation");

function resetCopyLabel(): void {
	copyLabel = "Copy conversation";
}

async function handleCopy(): Promise<void> {
	const text = tabStore.copyConversation();
	try {
		await navigator.clipboard.writeText(text);
		copyLabel = "Copied";
	} catch {
		copyLabel = "Failed";
	}
	setTimeout(resetCopyLabel, 1500);
}
</script>

<div class="flex flex-col gap-3">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Debug</div>

	<div class="flex flex-col gap-2">
		<p class="text-xs text-base-content/70">Conversation</p>
		<p class="text-xs text-base-content/40">
			Copy a structured plain-text dump of the active tab's conversation
			(chunk shape included) for bug reports.
		</p>
		<button type="button" class="btn btn-sm btn-primary w-full" onclick={handleCopy}>
			{copyLabel}
		</button>
	</div>
</div>
