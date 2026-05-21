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
		loading: boolean;
	}

	let entries = $state<KeyUsageEntry[]>([]);

	async function fetchOne(key: KeyInfo) {
		try {
			const res = await fetch(
				`${apiBase}/models/key-usage?keyId=${encodeURIComponent(key.id)}`,
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				updateEntry(key.id, {
					data: null,
					error: data.error ?? `HTTP ${res.status}`,
					loading: false,
				});
			} else {
				updateEntry(key.id, {
					data: await res.json(),
					error: null,
					loading: false,
				});
			}
		} catch (e) {
			updateEntry(key.id, {
				data: null,
				error: e instanceof Error ? e.message : "Failed to fetch",
				loading: false,
			});
		}
	}

	function updateEntry(
		keyId: string,
		patch: { data?: KeyUsageData | null; error?: string | null; loading?: boolean },
	) {
		entries = entries.map((e) =>
			e.keyId === keyId ? { ...e, ...patch } : e,
		);
	}

	$effect(() => {
		// Initialize all entries as loading
		entries = keys.map((k) => ({
			keyId: k.id,
			provider: k.provider,
			data: null,
			error: null,
			loading: true,
		}));
		// Fire all fetches in parallel
		for (const key of keys) {
			fetchOne(key);
		}

		// Refresh every 90s
		const interval = setInterval(() => {
			for (const key of keys) {
				updateEntry(key.id, { loading: true });
				fetchOne(key);
			}
		}, 90_000);

		return () => clearInterval(interval);
	});

	// Merge duplicate Claude entries — all anthropic keys return the same
	// set of accounts, so collect and deduplicate under one "Claude" card.
	const claudeAccounts = $derived.by(() => {
		const seen = new Set<string>();
		const accounts: Array<{
			label: string;
			source: string;
			subscriptionType?: string;
			fiveHour?: UsageBucket;
			sevenDay?: UsageBucket;
			error?: string;
		}> = [];
		const claudeEntries = entries.filter((e) => e.provider === "anthropic");
		for (const e of claudeEntries) {
			if (!e.data || e.data.provider !== "anthropic" || !e.data.accounts) continue;
			for (const acct of e.data.accounts) {
				if (!seen.has(acct.source)) {
					seen.add(acct.source);
					accounts.push(acct);
				}
			}
		}
		return accounts;
	});

	const claudeLoading = $derived(
		entries.some((e) => e.provider === "anthropic" && e.loading),
	);

	const nonClaudeEntries = $derived(
		entries.filter((e) => e.provider !== "anthropic"),
	);

	function progressClass(utilization: number): string {
		if (utilization > 0.8) return "progress-error";
		if (utilization >= 0.5) return "progress-warning";
		return "progress-success";
	}

	function formatDate(ts: number): string {
		const diff = ts - Date.now();
		const days = Math.floor(diff / 86400000);
		const d = new Date(ts);
		const dateStr = d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" });

		if (diff <= 0) {
			return d.toLocaleString();
		}
		if (diff < 48 * 60 * 60 * 1000) {
			const hours = Math.floor(diff / 3600000);
			const minutes = Math.floor((diff % 3600000) / 60000);
			return `in ${hours}:${String(minutes).padStart(2, "0")}`;
		}
		if (days <= 30) {
			const weeks = Math.floor(days / 7);
			const remDays = days % 7;
			if (weeks > 0 && remDays > 0) {
				return `in ${weeks}w ${remDays}d (${dateStr})`;
			}
			if (weeks > 0) {
				return `in ${weeks} week${weeks > 1 ? "s" : ""} (${dateStr})`;
			}
			return `in ${days} day${days > 1 ? "s" : ""} (${dateStr})`;
		}
		return d.toLocaleDateString("en-US", {
			month: "2-digit",
			day: "2-digit",
			year: "numeric",
		});
	}

	function hasBucketData(bucket: UsageBucket | undefined): boolean {
		return bucket !== undefined && bucket.utilization !== undefined;
	}
</script>

<div class="flex flex-col gap-3">
	{#if keys.length === 0}
		<p class="text-xs text-base-content/50">No keys available.</p>
	{:else}
		<div class="flex flex-col gap-3 max-h-96 overflow-y-auto">
			<!-- Claude (all accounts merged under one card) -->
			{#if claudeLoading}
				<div class="bg-base-200 rounded-lg p-2">
					<div class="flex items-center gap-1.5 mb-1.5">
						<span class="text-xs font-semibold">Claude</span>
						<span class="badge badge-xs badge-ghost">anthropic</span>
					</div>
					<div class="flex items-center gap-1.5 py-1">
						<span class="loading loading-spinner loading-xs"></span>
						<span class="text-xs text-base-content/50">Loading...</span>
					</div>
				</div>
			{:else if claudeAccounts.length > 0}
				<div class="bg-base-200 rounded-lg p-2">
					<div class="flex items-center gap-1.5 mb-1.5">
						<span class="text-xs font-semibold">Claude</span>
						<span class="badge badge-xs badge-ghost">anthropic</span>
					</div>
					{#each claudeAccounts as acct, idx (acct.source)}
						{#if idx > 0}
							<div class="border-t border-base-300 my-1.5"></div>
						{/if}
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
				</div>
			{/if}

			<!-- Non-Claude keys -->
			{#each nonClaudeEntries as entry (entry.keyId)}
				<div class="bg-base-200 rounded-lg p-2">
					<div class="flex items-center gap-1.5 mb-1.5">
						<span class="text-xs font-semibold">{entry.keyId}</span>
						<span class="badge badge-xs badge-ghost">{entry.provider}</span>
					</div>

					{#if entry.loading}
						<div class="flex items-center gap-1.5 py-1">
							<span class="loading loading-spinner loading-xs"></span>
							<span class="text-xs text-base-content/50">Loading...</span>
						</div>

					{:else if entry.error}
						<div role="alert" class="text-xs text-error/80">{entry.error}</div>

					{:else if !entry.data}
						<p class="text-xs text-base-content/50">No data.</p>

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
