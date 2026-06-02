<script lang="ts">
import { tick } from "svelte";
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

// ── Drag-and-drop reorder (user tabs only) ──
// Mirrors the native HTML5 DnD pattern used in AgentBuilder.svelte.
let dragIndex = $state<number | null>(null);
let dragOverIndex = $state<number | null>(null);

function dropReorder(targetIndex: number): void {
	if (dragIndex !== null && dragIndex !== targetIndex) {
		const ids = userTabs.map((t) => t.id);
		const moved = ids.splice(dragIndex, 1)[0];
		if (moved) {
			ids.splice(targetIndex, 0, moved);
			tabStore.reorderTabs(ids);
		}
	}
	dragIndex = null;
	dragOverIndex = null;
}

// ── Double-click rename (user tabs only) ──
let editingTabId = $state<string | null>(null);
let editValue = $state("");
let editInputEl = $state<HTMLInputElement | undefined>(undefined);

async function startRename(tab: { id: string; title: string }): Promise<void> {
	editingTabId = tab.id;
	editValue = tab.title;
	await tick();
	editInputEl?.focus();
	editInputEl?.select();
}

function commitRename(): void {
	if (editingTabId === null) return;
	const id = editingTabId;
	editingTabId = null;
	const next = editValue.trim();
	if (next) tabStore.renameTab(id, next);
}

function cancelRename(): void {
	editingTabId = null;
}

function handleRenameKeydown(e: KeyboardEvent): void {
	if (e.key === "Enter") {
		e.preventDefault();
		commitRename();
	} else if (e.key === "Escape") {
		e.preventDefault();
		cancelRename();
	}
}
</script>

<!-- Top row: user tabs -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="overflow-x-auto bg-base-200 flex-shrink-0 {hasSubagentTabs ? '' : 'rounded-br-lg'}"
	ondblclick={(e) => { if (e.target === e.currentTarget) tabStore.createNewTab(); }}
>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		role="tablist"
		tabindex="0"
		class="tabs tabs-lift min-w-max"
		ondblclick={(e) => { if (e.target === e.currentTarget) tabStore.createNewTab(); }}
	>
		<!-- New tab button — sticky-pinned to the left edge so it stays reachable
		     at any horizontal scroll; opaque bg + right-side shadow as a floating cue. -->
		<button
			type="button"
			class="tab !sticky left-0 z-10 bg-base-200 !rounded-ss-none shadow-[2px_0_4px_-1px_rgba(0,0,0,0.2)]"
			onclick={() => tabStore.createNewTab()}
			aria-label="New tab"
		>
			+
		</button>

		{#each userTabs as tab, i (tab.id)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				role="tab"
				class="tab !flex items-stretch gap-1.5 {tab.id === activeUserTabId ? 'tab-active' : ''} {dragOverIndex === i ? 'bg-primary/10' : ''} {dragIndex === i ? 'opacity-50' : ''}"
				draggable={editingTabId === tab.id ? "false" : "true"}
				onclick={() => tabStore.switchTab(tab.id)}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') tabStore.switchTab(tab.id); }}
				ondragstart={(e) => {
					dragIndex = i;
					if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				}}
				ondragover={(e) => {
					e.preventDefault();
					if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
					dragOverIndex = i;
				}}
				ondragleave={() => { if (dragOverIndex === i) dragOverIndex = null; }}
				ondrop={(e) => { e.preventDefault(); dropReorder(i); }}
				ondragend={() => { dragIndex = null; dragOverIndex = null; }}
				tabindex="0"
			>
				<span class="flex items-center gap-1.5">
					<span class="w-1.5 h-1.5 rounded-full shrink-0 {statusColor(tab.agentStatus)}"></span>
					<span class="font-mono text-[10px] px-1 py-0.5 rounded bg-base-300 text-base-content/60 shrink-0" title="Tab ID — agents address this tab by this handle">{tabStore.shortHandleFor(tab.id)}</span>
					{#if editingTabId === tab.id}
						<input
							bind:this={editInputEl}
							bind:value={editValue}
							class="max-w-32 text-xs bg-base-100 rounded px-1 outline-none ring-1 ring-primary/40"
							onclick={(e) => e.stopPropagation()}
							ondblclick={(e) => e.stopPropagation()}
							onkeydown={handleRenameKeydown}
							onblur={commitRename}
						/>
					{:else}
						<span
							class="max-w-32 truncate text-xs"
							ondblclick={(e) => { e.stopPropagation(); startRename(tab); }}
							title="Double-click to rename"
						>{tab.title}</span>
					{/if}
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

		<!-- Trailing padding after the last tab. Fills remaining space (big target),
		     shrinks to a small minimum when the bar overflows and scrolls.
		     Double-click anywhere in it to open a new tab. -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="flex-1 min-w-12 self-stretch cursor-default"
			ondblclick={() => tabStore.createNewTab()}
			title="Double-click to open a new tab"
		></div>
	</div>
</div>

<!-- Bottom row: subagent tabs (hidden when empty) -->
{#if hasSubagentTabs}
	<div class="overflow-x-auto bg-base-200 flex-shrink-0 border-t border-base-300 rounded-br-lg">
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
						<span class="font-mono text-[10px] px-1 rounded bg-base-300 text-base-content/60 shrink-0" title="Tab ID — agents address this tab by this handle">{tabStore.shortHandleFor(tab.id)}</span>
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
