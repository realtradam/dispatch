<script lang="ts">
import { router } from "../router.svelte.js";
import { wsClient } from "../ws.svelte.js";

const { onToggleSidebar }: { onToggleSidebar: () => void } = $props();
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
			onclick={onToggleSidebar}
			aria-label="Toggle sidebar"
		>
			Sidebar
		</button>
	</div>
</header>
