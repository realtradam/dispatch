<script lang="ts">
	import { onMount } from "svelte";
	import { appSettings } from "../settings.svelte.js";

	const {
		apiBase = "",
	}: {
		apiBase?: string;
	} = $props();

	const DEFAULT_PROMPT = "You are Dispatch, a helpful AI coding assistant. Be concise and helpful.";

	async function loadPrompt(): Promise<void> {
		try {
			const res = await fetch(`${apiBase}/tabs/settings/system_prompt`);
			if (res.ok) {
				const data = await res.json() as { value: string | null };
				const value = data.value ?? DEFAULT_PROMPT;
				appSettings.systemPrompt = value;
				appSettings.savedSystemPrompt = value;
			}
		} catch {
			// ignore
		}
	}

	function resetPrompt(): void {
		appSettings.systemPrompt = appSettings.savedSystemPrompt;
	}

	const isDirty = $derived(appSettings.systemPrompt !== appSettings.savedSystemPrompt);

	onMount(() => {
		if (!appSettings.systemPrompt) {
			appSettings.systemPrompt = DEFAULT_PROMPT;
			appSettings.savedSystemPrompt = DEFAULT_PROMPT;
		}
		loadPrompt();
	});
</script>

<div class="flex flex-col gap-3 flex-1 min-h-0">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">System Prompt</div>
	<p class="text-xs text-base-content/40">The base instructions sent to the AI at the start of every conversation. Tool descriptions are appended automatically. Changes are applied when you send your next message.</p>

	<textarea
		class="textarea textarea-bordered w-full flex-1 min-h-32 text-xs font-mono leading-relaxed"
		bind:value={appSettings.systemPrompt}
		placeholder="Enter system prompt..."
	></textarea>

	<button
		class="btn btn-sm btn-ghost w-full"
		disabled={!isDirty}
		onclick={resetPrompt}
	>
		Reset
	</button>

	<p class="text-xs text-base-content/40">Warning: changing the system prompt will reset the AI's prompt cache for active conversations, which may increase usage costs.</p>
</div>
