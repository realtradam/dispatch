<script lang="ts">
import { tick, untrack } from "svelte";
import { tabStore } from "../tabs.svelte.js";
import ChatMessageComponent from "./ChatMessage.svelte";

let messagesEl: HTMLDivElement | undefined;
let userScrolledUp = $state(false);
let isAutoScrolling = false;
let isLoadingMore = $state(false);

const renderGroups = $derived(tabStore.activeTab?.renderGroups ?? []);
const activeTabId = $derived(tabStore.activeTab?.id);
// Compaction placeholder state for the active tab. `compactingSource` is set on
// a transient placeholder tab while a conversation is being compacted;
// `compactionError` is set if it failed.
const compactingSource = $derived(tabStore.activeTab?.compactingSource ?? null);
const compactionError = $derived(tabStore.activeTab?.compactionError ?? null);

// Stable, turn-scoped render keys. A bubble's identity is `${turnId}:${role}:${n}`
// (n = its index among same-(turn,role) messages) rather than the underlying
// row/client id, so when the live turn reconciles into sealed chunk rows the
// bubble keeps its identity and does NOT remount (no flash). Falls back to the
// message id for anything without a turnId (e.g. optimistic/queued messages
// before turn-start, standalone system notices).
const keyedMessages = $derived.by(() => {
	const counts = new Map<string, number>();
	return renderGroups.map((m) => {
		if (!m.turnId) return { m, key: m.id };
		const base = `${m.turnId}:${m.role}`;
		const n = counts.get(base) ?? 0;
		counts.set(base, n + 1);
		return { m, key: `${base}:${n}` };
	});
});

function isNearBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.scrollTop - el.clientHeight < 64;
}

function scrollToBottom(animate = false) {
	if (!messagesEl) return;
	messagesEl.scrollTo({
		top: messagesEl.scrollHeight,
		behavior: animate ? "smooth" : "instant",
	});
}

async function onNearTop() {
	if (isLoadingMore) return;
	const tab = tabStore.activeTab;
	if (!tab) return;
	// Nothing older to load if we're already at the very first message, or if
	// we already hold every message the backend has for this tab.
	if (tab.oldestLoadedSeq !== null && tab.oldestLoadedSeq <= 0) return;

	isLoadingMore = true;
	const prevScrollHeight = messagesEl?.scrollHeight ?? 0;
	const prevScrollTop = messagesEl?.scrollTop ?? 0;
	try {
		await tabStore.loadOlderChunks(tab.id);
		// Wait for Svelte to flush the prepended messages into the DOM.
		// Reading `scrollHeight` synchronously after the await would observe
		// the OLD layout (reactive updates are batched), so the scroll
		// correction would be computed against a stale height and the
		// viewport would jump. `tick()` resolves once the DOM reflects the
		// new message list.
		await tick();
		if (messagesEl) {
			const newScrollHeight = messagesEl.scrollHeight;
			const delta = newScrollHeight - prevScrollHeight;
			// Only adjust when content was actually prepended above the
			// viewport. If nothing was added (all duplicates / nothing older),
			// `delta` is 0 and we leave the user where they are instead of
			// snapping to the top.
			if (delta > 0) {
				messagesEl.scrollTop = prevScrollTop + delta;
			}
		}
	} finally {
		isLoadingMore = false;
	}
}

function handleScroll() {
	if (!messagesEl || isAutoScrolling) return;
	const wasScrolledUp = userScrolledUp;
	userScrolledUp = !isNearBottom(messagesEl);
	if (activeTabId) tabStore.setScrolledUp(activeTabId, userScrolledUp);
	// User just scrolled back to the bottom manually — safe to evict now.
	if (wasScrolledUp && !userScrolledUp && activeTabId) {
		tabStore.evictChunks(activeTabId);
	}
	// Near the top — pull in older history.
	if (userScrolledUp && messagesEl.scrollTop < 200) {
		void onNearTop();
	}
}

function resumeAutoScroll() {
	userScrolledUp = false;
	isAutoScrolling = true;
	if (activeTabId) {
		tabStore.setScrolledUp(activeTabId, false);
		tabStore.evictChunks(activeTabId);
	}
	scrollToBottom(true);
}

$effect(() => {
	const count = renderGroups.length;
	void count;
	if (messagesEl) {
		untrack(() => {
			if (!userScrolledUp) scrollToBottom(false);
		});
	}
});

$effect(() => {
	const prevTabId = activeTabId;
	// Reset scroll state when switching tabs
	userScrolledUp = false;
	isAutoScrolling = false;
	return () => {
		if (prevTabId) {
			tabStore.setScrolledUp(prevTabId, false);
		}
	};
});
</script>

<div class="flex flex-col h-full">
	<!-- Messages -->
	<div class="relative flex-1 min-h-0">
		<div
			bind:this={messagesEl}
			class="h-full overflow-y-auto p-4"
			onscroll={handleScroll}
			onscrollend={() => {
				isAutoScrolling = false;
			}}
		>
			{#if isLoadingMore}
				<div class="text-center text-xs text-base-content/40 py-2">Loading earlier messages...</div>
			{/if}
			{#if compactingSource || compactionError}
				<div class="flex flex-col items-center justify-center h-full gap-4 px-6 text-center">
					{#if compactionError}
						<div class="text-2xl font-semibold text-error">Compaction failed</div>
						<div class="text-base text-base-content/70 max-w-md">{compactionError}</div>
						<div class="text-sm text-base-content/50">Close this tab to dismiss — your conversation was not changed.</div>
					{:else}
						<span class="loading loading-spinner loading-lg text-primary"></span>
						<div class="text-2xl font-semibold text-base-content">Please wait, compacting conversation…</div>
						<div class="text-sm text-base-content/50">You can cancel by closing this tab.</div>
					{/if}
				</div>
			{:else if renderGroups.length === 0}
				<div class="flex items-center justify-center h-full text-base-content/40 text-sm">
					Send a message to start a conversation
				</div>
			{/if}
			{#if !compactingSource && !compactionError}
				{#each keyedMessages as { m, key } (key)}
					<ChatMessageComponent message={m} tabId={activeTabId} />
				{/each}
			{/if}
		</div>

		<!-- Scroll-to-bottom button -->
		<button
			type="button"
			class="absolute bottom-0 left-1/2 -translate-x-1/2 mb-4 btn btn-sm px-8 rounded-lg shadow-lg transition-opacity duration-200 {userScrolledUp ? 'opacity-100' : 'opacity-0 pointer-events-none'}"
			onclick={resumeAutoScroll}
			aria-label="Scroll to bottom"
			tabindex={userScrolledUp ? 0 : -1}
		>
			&#x25BC;
		</button>
	</div>
</div>
