<script lang="ts">
	import { untrack } from "svelte";
	import { tabStore } from "../tabs.svelte.js";
	import ChatMessageComponent from "./ChatMessage.svelte";

	let messagesEl: HTMLDivElement | undefined;
	let userScrolledUp = $state(false);
	let isAutoScrolling = false;

	const messages = $derived(tabStore.activeTab?.messages ?? []);

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

	function handleScroll() {
		if (!messagesEl || isAutoScrolling) return;
		userScrolledUp = !isNearBottom(messagesEl);
	}

	function resumeAutoScroll() {
		userScrolledUp = false;
		isAutoScrolling = true;
		scrollToBottom(true);
	}

	$effect(() => {
		const count = messages.length;
		void count;
		if (messagesEl) {
			untrack(() => {
				if (!userScrolledUp) scrollToBottom(false);
			});
		}
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
			{#if messages.length === 0}
				<div class="flex items-center justify-center h-full text-base-content/40 text-sm">
					Send a message to start a conversation
				</div>
			{/if}
			{#each messages as message (message.id)}
				<ChatMessageComponent {message} />
			{/each}
		</div>

		<!-- Scroll-to-bottom button -->
		<button
			type="button"
			class="absolute bottom-0 left-1/2 -translate-x-1/2 mb-4 btn btn-circle btn-sm shadow-lg transition-opacity duration-200 {userScrolledUp ? 'opacity-100' : 'opacity-0 pointer-events-none'}"
			onclick={resumeAutoScroll}
			aria-label="Scroll to bottom"
			tabindex={userScrolledUp ? 0 : -1}
		>
			↓
		</button>
	</div>
</div>
