<script lang="ts">
import { router } from "../router.svelte.js";
import { tabStore } from "../tabs.svelte.js";
import { wsClient } from "../ws.svelte.js";
import ThemeSwitcher from "./ThemeSwitcher.svelte";

const { onToggleSidebar }: { onToggleSidebar: () => void } = $props();

let showThemeSwitcher = $state(false);
let copyLabel = $state("Copy");

function resetCopyLabel() {
	copyLabel = "Copy";
}

async function handleCopy() {
	const text = tabStore.copyConversation();
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

<header class="navbar bg-base-200 px-4 min-h-14 flex-shrink-0">
	<div class="navbar-start">
		<button class="text-xl font-bold tracking-tight btn btn-ghost px-0" onclick={() => router.navigate("dashboard")}>Dispatch</button>
	</div>
	<div class="navbar-end flex items-center gap-3">
		<span class="flex items-center gap-1.5 text-xs text-base-content/60">
			<span class="status status-sm {wsClient.connectionStatus === 'connected' ? 'status-success' : wsClient.connectionStatus === 'connecting' ? 'status-warning' : 'status-error'}"></span>
			<span class="capitalize">{wsClient.connectionStatus}</span>
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
			Sidebar
		</button>
	</div>
</header>

{#if showThemeSwitcher}
	<ThemeSwitcher onclose={() => (showThemeSwitcher = false)} />
{/if}
