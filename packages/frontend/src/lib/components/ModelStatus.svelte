<script lang="ts">
	interface KeyInfo {
		id: string;
		provider: string;
		status: "active" | "exhausted";
		lastError: string | null;
		exhaustedAt: number | null;
	}

	interface ModelInfo {
		id: string;
		provider: string;
		tags: string[];
	}

	const {
		models = [],
		keys = [],
		tags = [],
		currentModel,
	}: {
		models?: ModelInfo[];
		keys?: KeyInfo[];
		tags?: string[];
		currentModel?: string;
	} = $props();

	const activeKeys = $derived(keys.filter((k) => k.status === "active").length);
	const totalKeys = $derived(keys.length);
	const allActive = $derived(totalKeys > 0 && activeKeys === totalKeys);
	const allExhausted = $derived(totalKeys > 0 && activeKeys === 0);
	const someExhausted = $derived(totalKeys > 0 && activeKeys < totalKeys && activeKeys > 0);

	const uniqueTags = $derived([...new Set(tags)]);

	function timeAgo(ts: number | null): string {
		if (ts === null) return "";
		const diffMs = Date.now() - ts;
		const diffSec = Math.floor(diffMs / 1000);
		if (diffSec < 60) return `${diffSec}s ago`;
		const diffMin = Math.floor(diffSec / 60);
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffHr = Math.floor(diffMin / 60);
		return `${diffHr}h ago`;
	}

	function truncate(str: string | null, max: number): string {
		if (!str) return "";
		return str.length > max ? str.slice(0, max) + "…" : str;
	}
</script>

<div class="flex flex-col gap-3">
	{#if models.length === 0 && keys.length === 0}
		<p class="text-xs text-base-content/50">
			No models configured. Using environment defaults.
		</p>
	{:else}
		<!-- Overall status -->
		{#if allActive}
			<div class="flex items-center gap-1.5">
				<span class="badge badge-success badge-xs">●</span>
				<span class="text-xs text-success">All keys available</span>
			</div>
		{:else if allExhausted}
			<div class="flex items-center gap-1.5">
				<span class="badge badge-error badge-xs">●</span>
				<span class="text-xs text-error">All keys exhausted — waiting for refresh</span>
			</div>
		{:else if someExhausted}
			<div class="flex items-center gap-1.5">
				<span class="badge badge-warning badge-xs">●</span>
				<span class="text-xs text-warning">
					Fallback active ({activeKeys}/{totalKeys} keys available)
				</span>
			</div>
		{/if}

		<!-- Current model -->
		{#if currentModel}
			<div class="flex flex-col gap-0.5">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">Current Model</p>
				<p class="text-sm font-mono font-semibold text-primary">{currentModel}</p>
			</div>
		{/if}

		<!-- Tags -->
		{#if uniqueTags.length > 0}
			<div class="flex flex-col gap-1">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">Tags</p>
				<div class="flex flex-wrap gap-1">
					{#each uniqueTags as tag (tag)}
						<span class="badge badge-outline badge-xs">{tag}</span>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Keys -->
		{#if keys.length > 0}
			<div class="flex flex-col gap-1">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">API Keys</p>
				<ul class="flex flex-col gap-1">
					{#each keys as key (key.id)}
						<li class="flex flex-col gap-0.5 rounded p-1 hover:bg-base-200 transition-colors">
							<div class="flex items-center gap-1.5">
								<span
									class="badge badge-xs {key.status === 'active'
										? 'badge-success'
										: 'badge-error'}"
								>
									{key.status}
								</span>
								<span class="text-xs font-mono">{key.id}</span>
								<span class="text-xs text-base-content/40">{key.provider}</span>
							</div>
							{#if key.status === "exhausted"}
								<div class="pl-2 flex flex-col gap-0.5">
									{#if key.lastError}
										<p class="text-xs text-error/70 line-clamp-1">
											{truncate(key.lastError, 80)}
										</p>
									{/if}
									{#if key.exhaustedAt !== null}
										<p class="text-xs text-base-content/40">{timeAgo(key.exhaustedAt)}</p>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	{/if}
</div>
