<script lang="ts">
import { chatStore } from "../chat.svelte.js";
import ThemeSwitcher from "./ThemeSwitcher.svelte";

const { onToggleSidebar }: { onToggleSidebar: () => void } = $props();

let showThemeSwitcher = $state(false);
let copyLabel = $state("Copy");

function resetCopyLabel() {
	copyLabel = "Copy";
}

async function handleCopy() {
	const text = chatStore.copyConversation();
	try {
		await navigator.clipboard.writeText(text);
		copyLabel = "Copied";
		setTimeout(resetCopyLabel, 1500);
	} catch {
		copyLabel = "Failed";
		setTimeout(resetCopyLabel, 1500);
	}
}
</script>

<header class="navbar bg-base-200 border-b border-base-300 px-4 min-h-14 flex-shrink-0">
	<div class="navbar-start">
		<span class="text-xl font-bold tracking-tight">Dispatch</span>
	</div>
	<div class="navbar-end flex items-center gap-3">
		<span class="text-xs text-base-content/60 hidden sm:block">
			DeepSeek V4 Flash via OpenCode Go
		</span>
		<button
			type="button"
			class="btn btn-ghost btn-sm"
			onclick={handleCopy}
			aria-label="Copy conversation"
		>
			{copyLabel}
		</button>
		<button
			type="button"
			class="btn btn-ghost btn-sm"
			onclick={() => (showThemeSwitcher = !showThemeSwitcher)}
			aria-label="Switch theme"
		>
			Theme
		</button>
		<button
			type="button"
			class="btn btn-ghost btn-sm"
			onclick={onToggleSidebar}
			aria-label="Toggle sidebar"
		>
			☰ Sidebar
		</button>
	</div>
</header>

{#if showThemeSwitcher}
	<ThemeSwitcher onclose={() => (showThemeSwitcher = false)} />
{/if}
