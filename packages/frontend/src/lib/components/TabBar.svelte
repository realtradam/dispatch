<script lang="ts">
	import { tabStore } from "../tabs.svelte.js";

	function statusColor(status: string): string {
		if (status === "running") return "bg-warning";
		if (status === "error") return "bg-error";
		return "bg-success";
	}
</script>

<div class="overflow-x-auto bg-base-200 flex-shrink-0">
	<div role="tablist" class="tabs tabs-lift min-w-max">
		<!-- New tab button — always first -->
		<button
			type="button"
			class="tab"
			onclick={() => tabStore.createNewTab()}
			aria-label="New tab"
		>
			+
		</button>

		{#each tabStore.tabs as tab (tab.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				role="tab"
				class="tab {tab.id === tabStore.activeTabId ? 'tab-active' : ''}"
				onclick={() => tabStore.switchTab(tab.id)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') tabStore.switchTab(tab.id); }}
				tabindex="0"
			>
				<span class="flex items-center gap-1.5">
					<span class="w-1.5 h-1.5 rounded-full shrink-0 {statusColor(tab.agentStatus)}"></span>
					<span class="max-w-32 truncate text-xs">{tab.title}</span>
					<button
						type="button"
						class="ml-0.5 text-base-content/30 hover:text-error transition-colors text-xs leading-none"
						onclick={(e) => { e.stopPropagation(); tabStore.closeTab(tab.id); }}
						aria-label="Close tab"
					>
						x
					</button>
				</span>
			</div>
		{/each}
	</div>
</div>
