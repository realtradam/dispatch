<script lang="ts">
	const { active }: { active: boolean } = $props();

	let visible = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		if (active) {
			visible = true;
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(() => {
				visible = false;
				timer = null;
			}, 2000);
		}
		return () => {
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			visible = false;
		};
	});
</script>

{#if visible}
	<div
		class="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-info/20 text-info text-xs font-medium animate-pulse"
		role="status"
		aria-live="polite"
	>
		<span class="status status-xs status-info"></span>
		<span>Config reloaded</span>
	</div>
{/if}
