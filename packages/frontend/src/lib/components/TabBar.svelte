<script lang="ts">
import { tabStore } from "../tabs.svelte.js";

function statusColor(status: string): string {
	if (status === "running") return "bg-warning";
	if (status === "error") return "bg-error";
	return "bg-success";
}

const userTabs = $derived(tabStore.tabs.filter((t) => t.parentTabId === null));
const subagentTabs = $derived(
	tabStore.tabs.filter((t) => t.parentTabId !== null && t.parentTabId === activeUserTabId),
);
const hasSubagentTabs = $derived(subagentTabs.length > 0);

// When a subagent tab is active, its parent user tab should still appear selected
const activeTab = $derived(tabStore.tabs.find((t) => t.id === tabStore.activeTabId));
const activeUserTabId = $derived(
	activeTab?.parentTabId !== null && activeTab?.parentTabId !== undefined
		? activeTab.parentTabId
		: tabStore.activeTabId,
);
</script>

<!-- Top row: user tabs -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="overflow-x-auto bg-base-200 flex-shrink-0"
	ondblclick={(e) => { if (e.target === e.currentTarget) tabStore.createNewTab(); }}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		role="tablist"
		class="tabs tabs-lift min-w-max"
		ondblclick={(e) => { if (e.target === e.currentTarget) tabStore.createNewTab(); }}
	>
		<!-- New tab button — always first -->
		<button
			type="button"
			class="tab"
			onclick={() => tabStore.createNewTab()}
			aria-label="New tab"
		>
			+
		</button>

		{#each userTabs as tab (tab.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				role="tab"
				class="tab !flex items-stretch gap-1.5 {tab.id === activeUserTabId ? 'tab-active' : ''}"
				onclick={() => tabStore.switchTab(tab.id)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') tabStore.switchTab(tab.id); }}
				tabindex="0"
			>
				<span class="flex items-center gap-1.5">
					<span class="w-1.5 h-1.5 rounded-full shrink-0 {statusColor(tab.agentStatus)}"></span>
					<span class="max-w-32 truncate text-xs">{tab.title}</span>
				</span>
				<button
					type="button"
					class="flex items-center justify-center px-3 my-1 leading-none text-base-content/30 hover:text-error hover:bg-base-300 rounded transition-colors text-xs"
					onclick={(e) => { e.stopPropagation(); tabStore.closeTab(tab.id); }}
					aria-label="Close tab"
				>
					&#x2715;
				</button>
			</div>
		{/each}
	</div>
</div>

<!-- Bottom row: subagent tabs (hidden when empty) -->
{#if hasSubagentTabs}
	<div class="overflow-x-auto bg-base-200 flex-shrink-0 border-t border-base-300">
		<div
			role="tablist"
			class="tabs tabs-lift tabs-xs min-w-max"
		>
			{#each subagentTabs as tab (tab.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					role="tab"
					class="tab !flex items-stretch gap-1 {tab.id === tabStore.activeTabId ? 'tab-active' : ''} {!tab.persistent ? 'opacity-70 italic' : ''}"
					onclick={() => tab.persistent ? tabStore.switchTab(tab.id) : tabStore.promoteTab(tab.id)}
					onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') tab.persistent ? tabStore.switchTab(tab.id) : tabStore.promoteTab(tab.id); }}
					tabindex="0"
				>
					<span class="flex items-center gap-1">
						<span class="w-1 h-1 rounded-full shrink-0 {statusColor(tab.agentStatus)}"></span>
						<span class="max-w-28 truncate text-xs">{tab.title}</span>
					</span>
					{#if tab.persistent}
						<button
							type="button"
							class="flex items-center justify-center px-2 my-0.5 leading-none text-base-content/30 hover:text-error hover:bg-base-300 rounded transition-colors text-xs"
							onclick={(e) => { e.stopPropagation(); tabStore.closeTab(tab.id); }}
							aria-label="Close tab"
						>
							&#x2715;
						</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
