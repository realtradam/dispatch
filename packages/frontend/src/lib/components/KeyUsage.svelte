<script lang="ts">
	import type { KeyInfo, KeyUsageData, UsageBucket } from "../types.js";

	const {
		keys = [],
		apiBase = "",
	}: {
		keys?: KeyInfo[];
		apiBase?: string;
	} = $props();

	interface KeyUsageEntry {
		keyId: string;
		provider: string;
		data: KeyUsageData | null;
		error: string | null;
	}

	let entries = $state<KeyUsageEntry[]>([]);
	let loading = $state(true);

	async function fetchAll() {
		loading = true;
		const results: KeyUsageEntry[] = [];

		for (const key of keys) {
			try {
				const res = await fetch(
					`${apiBase}/models/key-usage?keyId=${encodeURIComponent(key.id)}`,
				);
				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					results.push({
						keyId: key.id,
						provider: key.provider,
						data: null,
						error: data.error ?? `HTTP ${res.status}`,
					});
				} else {
					results.push({
						keyId: key.id,
						provider: key.provider,
						data: await res.json(),
						error: null,
					});
				}
			} catch (e) {
				results.push({
					keyId: key.id,
					provider: key.provider,
					data: null,
					error: e instanceof Error ? e.message : "Failed to fetch",
				});
			}
		}

		entries = results;
		loading = false;
	}

	$effect(() => {
		fetchAll();
	});

	function progressClass(utilization: number): string {
		if (utilization > 0.8) return "progress-error";
		if (utilization >= 0.5) return "progress-warning";
		return "progress-success";
	}

	function formatDate(ts: number): string {
		return new Date(ts).toLocaleString();
	}

	function hasBucketData(bucket: UsageBucket | undefined): boolean {
		return bucket !== undefined && bucket.utilization !== undefined;
	}
</script>

<div class="flex flex-col gap-3">
	{#if keys.length === 0}
		<p class="text-xs text-base-content/50">No keys available.</p>
	{:else if loading}
		<div class="flex items-center gap-2 py-2">
			<span class="loading loading-spinner loading-sm"></span>
			<span class="text-xs text-base-content/50">Loading usage data...</span>
		</div>
	{:else}
		<div class="flex flex-col gap-3 max-h-96 overflow-y-auto">
			{#each entries as entry (entry.keyId)}
				<div
					class="bg-base-200 rounded-lg p-2"
				>
					<div class="flex items-center gap-1.5 mb-1.5">
						<span class="text-xs font-semibold">{entry.keyId}</span>
						<span class="badge badge-xs badge-ghost">{entry.provider}</span>
					</div>

					{#if entry.error}
						<div role="alert" class="text-xs text-error/80">{entry.error}</div>

					{:else if !entry.data}
						<p class="text-xs text-base-content/50">No data.</p>

					{:else if entry.data.provider === "anthropic"}
						<!-- Render each Claude account -->
						{#if entry.data.accounts}
							{#each entry.data.accounts as acct (acct.source)}
								<div class="flex flex-col gap-1 pl-1">
									<div class="flex items-center gap-1">
										<span class="text-xs font-medium">{acct.label}</span>
										{#if acct.subscriptionType}
											<span class="badge badge-xs">{acct.subscriptionType}</span>
										{/if}
									</div>

									{#if acct.error}
										<p class="text-xs text-error/70">{acct.error}</p>
									{/if}

									{#if hasBucketData(acct.fiveHour)}
										{@const b = acct.fiveHour!}
										{@const u = b.utilization ?? 0}
										{@const p = Math.round(u * 100)}
										<div class="flex flex-col gap-0.5">
											<div class="flex items-center justify-between">
												<span class="text-xs text-base-content/50">5-Hour</span>
												<span class="text-xs font-mono">{p}%</span>
											</div>
											<progress class="progress w-full h-2 {progressClass(u)}" value={p} max="100"></progress>
											{#if b.resetsAt}
												<span class="text-xs text-base-content/40">Resets: {formatDate(b.resetsAt)}</span>
											{/if}
										</div>
									{/if}

									{#if hasBucketData(acct.sevenDay)}
										{@const b = acct.sevenDay!}
										{@const u = b.utilization ?? 0}
										{@const p = Math.round(u * 100)}
										<div class="flex flex-col gap-0.5">
											<div class="flex items-center justify-between">
												<span class="text-xs text-base-content/50">Weekly</span>
												<span class="text-xs font-mono">{p}%</span>
											</div>
											<progress class="progress w-full h-2 {progressClass(u)}" value={p} max="100"></progress>
											{#if b.resetsAt}
												<span class="text-xs text-base-content/40">Resets: {formatDate(b.resetsAt)}</span>
											{/if}
										</div>
									{/if}
								</div>
							{/each}
						{/if}

					{:else if entry.data.provider === "opencode-go"}
						{#if entry.data.unavailable}
							<p class="text-xs text-base-content/70">Check console for usage.</p>
							{#if entry.data.consoleUrl}
								<a href={entry.data.consoleUrl} target="_blank" rel="noopener noreferrer" class="link link-primary text-xs">
									Open console
								</a>
							{/if}
						{:else}
							{#if hasBucketData(entry.data.fiveHour)}
								{@const b = entry.data.fiveHour!}
								{@const u = b.utilization ?? 0}
								{@const p = Math.round(u * 100)}
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center justify-between">
										<span class="text-xs text-base-content/50">5-Hour</span>
										<span class="text-xs font-mono">{p}%</span>
									</div>
									<progress class="progress w-full h-2 {progressClass(u)}" value={p} max="100"></progress>
									{#if b.resetsAt}
										<span class="text-xs text-base-content/40">Resets: {formatDate(b.resetsAt)}</span>
									{/if}
								</div>
							{/if}
							{#if hasBucketData(entry.data.weekly)}
								{@const b = entry.data.weekly!}
								{@const u = b.utilization ?? 0}
								{@const p = Math.round(u * 100)}
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center justify-between">
										<span class="text-xs text-base-content/50">Weekly</span>
										<span class="text-xs font-mono">{p}%</span>
									</div>
									<progress class="progress w-full h-2 {progressClass(u)}" value={p} max="100"></progress>
									{#if b.resetsAt}
										<span class="text-xs text-base-content/40">Resets: {formatDate(b.resetsAt)}</span>
									{/if}
								</div>
							{/if}
							{#if hasBucketData(entry.data.monthly)}
								{@const b = entry.data.monthly!}
								{@const u = b.utilization ?? 0}
								{@const p = Math.round(u * 100)}
								<div class="flex flex-col gap-0.5">
									<div class="flex items-center justify-between">
										<span class="text-xs text-base-content/50">Monthly</span>
										<span class="text-xs font-mono">{p}%</span>
									</div>
									<progress class="progress w-full h-2 {progressClass(u)}" value={p} max="100"></progress>
									{#if b.resetsAt}
										<span class="text-xs text-base-content/40">Resets: {formatDate(b.resetsAt)}</span>
									{/if}
								</div>
							{/if}
						{/if}

					{:else if entry.data.provider === "github-copilot"}
						{@const p = Math.round(entry.data.percentUsed ?? 0)}
						<div class="flex flex-col gap-0.5 pl-1">
							<div class="flex items-center justify-between">
								<span class="text-xs text-base-content/50">
									{#if entry.data.tokensConsumed !== undefined && entry.data.tokensRemaining !== undefined}
										{entry.data.tokensConsumed.toLocaleString()} / {(entry.data.tokensConsumed + entry.data.tokensRemaining).toLocaleString()} tokens
									{:else if entry.data.plan}
										{entry.data.plan}
									{:else}
										Usage
									{/if}
								</span>
								<span class="text-xs font-mono">{p}%</span>
							</div>
							<progress class="progress w-full h-2 {progressClass(p / 100)}" value={p} max="100"></progress>
							{#if entry.data.resetAt}
								<span class="text-xs text-base-content/40">Resets: {formatDate(entry.data.resetAt)}</span>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
