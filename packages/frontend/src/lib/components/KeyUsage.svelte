<script lang="ts">
	import type { KeyInfo, KeyUsageData, UsageBucket } from "../types.js";

	const {
		keys = [],
		apiBase = "",
	}: {
		keys?: KeyInfo[];
		apiBase?: string;
	} = $props();

	let selectedKeyId = $state<string | null>(null);
	let usageData = $state<KeyUsageData | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Set default key when keys load asynchronously
	$effect(() => {
		if (selectedKeyId === null && keys.length > 0) {
			selectedKeyId = keys[0]?.id ?? null;
		}
	});

	async function fetchUsage(keyId: string) {
		loading = true;
		error = null;
		usageData = null;
		try {
			const res = await fetch(`${apiBase}/models/key-usage?keyId=${encodeURIComponent(keyId)}`);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				throw new Error(data.error ?? `HTTP ${res.status}: ${res.statusText}`);
			}
			usageData = await res.json();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to fetch usage data";
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (selectedKeyId) {
			fetchUsage(selectedKeyId);
		}
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

	const hasAnyData = $derived.by(() => {
		if (!usageData) return false;
		if (usageData.provider === "anthropic") {
			return hasBucketData(usageData.fiveHour) || hasBucketData(usageData.sevenDay);
		}
		if (usageData.provider === "opencode-go") {
			// OpenCode has no API data but we always have something to show
			return true;
		}
		if (usageData.provider === "github-copilot") {
			return usageData.percentUsed !== undefined || usageData.tokensConsumed !== undefined;
		}
		return false;
	});
</script>

<div class="flex flex-col gap-3">
	<!-- Key selector -->
	{#if keys.length > 0}
		<select
			class="select select-bordered select-sm w-full"
			bind:value={selectedKeyId}
		>
			{#each keys as key (key.id)}
				<option value={key.id}>{key.id} ({key.provider})</option>
			{/each}
		</select>
	{:else}
		<p class="text-xs text-base-content/50">No keys available.</p>
	{/if}

	<!-- Loading -->
	{#if loading}
		<div class="flex items-center gap-2 py-2">
			<span class="loading loading-spinner loading-sm"></span>
			<span class="text-xs text-base-content/50">Loading usage data...</span>
		</div>
	{/if}

	<!-- Error -->
	{#if error}
		<div role="alert" class="alert alert-error alert-soft py-2 px-3 text-xs">
			{error}
		</div>
	{/if}

	<!-- Usage data -->
	{#if !loading && usageData}
		{#if !hasAnyData}
			<p class="text-xs text-base-content/50">No usage data available for this key.</p>

		{:else if usageData.provider === "anthropic"}
			<div class="flex flex-col gap-2">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">Claude Usage</p>

				{#if hasBucketData(usageData.fiveHour)}
					{@const bucket = usageData.fiveHour!}
					{@const util = bucket.utilization ?? 0}
					{@const pct = Math.round(util * 100)}
					<div class="flex flex-col gap-0.5">
						<p class="text-xs text-base-content/50">5-Hour Window</p>
						<progress
							class="progress w-full {progressClass(util)}"
							value={pct}
							max="100"
						></progress>
						<div class="flex items-center justify-between">
							<span class="text-xs font-mono">{pct}%</span>
							{#if bucket.resetsAt}
								<span class="text-xs text-base-content/40">Resets: {formatDate(bucket.resetsAt)}</span>
							{/if}
						</div>
					</div>
				{/if}

				{#if hasBucketData(usageData.sevenDay)}
					{@const bucket = usageData.sevenDay!}
					{@const util = bucket.utilization ?? 0}
					{@const pct = Math.round(util * 100)}
					<div class="flex flex-col gap-0.5">
						<p class="text-xs text-base-content/50">Weekly (7-Day)</p>
						<progress
							class="progress w-full {progressClass(util)}"
							value={pct}
							max="100"
						></progress>
						<div class="flex items-center justify-between">
							<span class="text-xs font-mono">{pct}%</span>
							{#if bucket.resetsAt}
								<span class="text-xs text-base-content/40">Resets: {formatDate(bucket.resetsAt)}</span>
							{/if}
						</div>
					</div>
				{/if}
			</div>

		{:else if usageData.provider === "opencode-go"}
			<div class="flex flex-col gap-2">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">OpenCode Usage</p>

				{#if usageData.unavailable}
					<p class="text-xs text-base-content/70">
						OpenCode does not expose usage data via API.
					</p>
					{#if usageData.limits}
						<div class="flex flex-col gap-1">
							<p class="text-xs text-base-content/50">Rate Limits</p>
							<ul class="text-xs text-base-content/70 list-disc pl-4 flex flex-col gap-0.5">
								{#if usageData.limits.fiveHour}
									<li>5-Hour: {usageData.limits.fiveHour}</li>
								{/if}
								{#if usageData.limits.weekly}
									<li>Weekly: {usageData.limits.weekly}</li>
								{/if}
								{#if usageData.limits.monthly}
									<li>Monthly: {usageData.limits.monthly}</li>
								{/if}
							</ul>
						</div>
					{/if}
					{#if usageData.consoleUrl}
						<a
							href={usageData.consoleUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="link link-primary text-xs"
						>
							View usage in console
						</a>
					{/if}
				{:else}
					<!-- If API data ever becomes available, render buckets -->
					{#if hasBucketData(usageData.fiveHour)}
						{@const bucket = usageData.fiveHour!}
						{@const util = bucket.utilization ?? 0}
						{@const pct = Math.round(util * 100)}
						<div class="flex flex-col gap-0.5">
							<p class="text-xs text-base-content/50">5-Hour Window</p>
							<progress
								class="progress w-full {progressClass(util)}"
								value={pct}
								max="100"
							></progress>
							<div class="flex items-center justify-between">
								<span class="text-xs font-mono">{pct}%</span>
								{#if bucket.resetsAt}
									<span class="text-xs text-base-content/40">Resets: {formatDate(bucket.resetsAt)}</span>
								{/if}
							</div>
						</div>
					{/if}

					{#if hasBucketData(usageData.weekly)}
						{@const bucket = usageData.weekly!}
						{@const util = bucket.utilization ?? 0}
						{@const pct = Math.round(util * 100)}
						<div class="flex flex-col gap-0.5">
							<p class="text-xs text-base-content/50">Weekly</p>
							<progress
								class="progress w-full {progressClass(util)}"
								value={pct}
								max="100"
							></progress>
							<div class="flex items-center justify-between">
								<span class="text-xs font-mono">{pct}%</span>
								{#if bucket.resetsAt}
									<span class="text-xs text-base-content/40">Resets: {formatDate(bucket.resetsAt)}</span>
								{/if}
							</div>
						</div>
					{/if}

					{#if hasBucketData(usageData.monthly)}
						{@const bucket = usageData.monthly!}
						{@const util = bucket.utilization ?? 0}
						{@const pct = Math.round(util * 100)}
						<div class="flex flex-col gap-0.5">
							<p class="text-xs text-base-content/50">Monthly</p>
							<progress
								class="progress w-full {progressClass(util)}"
								value={pct}
								max="100"
							></progress>
							<div class="flex items-center justify-between">
								<span class="text-xs font-mono">{pct}%</span>
								{#if bucket.resetsAt}
									<span class="text-xs text-base-content/40">Resets: {formatDate(bucket.resetsAt)}</span>
								{/if}
							</div>
						</div>
					{/if}
				{/if}
			</div>

		{:else if usageData.provider === "github-copilot"}
			{@const pct = Math.round(usageData.percentUsed ?? 0)}
			<div class="flex flex-col gap-2">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">Copilot Usage</p>
				<div class="flex flex-col gap-0.5">
					<progress
						class="progress w-full {progressClass(pct / 100)}"
						value={pct}
						max="100"
					></progress>
					<div class="flex items-center justify-between">
						{#if usageData.tokensConsumed !== undefined && usageData.tokensRemaining !== undefined}
							<span class="text-xs font-mono">
								{usageData.tokensConsumed.toLocaleString()} / {(usageData.tokensConsumed + usageData.tokensRemaining).toLocaleString()} ({pct}%)
							</span>
						{:else}
							<span class="text-xs font-mono">{pct}%</span>
						{/if}
						{#if usageData.resetAt}
							<span class="text-xs text-base-content/40">Resets: {formatDate(usageData.resetAt)}</span>
						{/if}
					</div>
				</div>
			</div>
		{/if}
	{/if}
</div>
