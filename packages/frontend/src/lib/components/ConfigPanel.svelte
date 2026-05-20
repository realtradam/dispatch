<script lang="ts">
	interface AgentTemplate {
		name: string;
		description?: string;
		model_tag?: string;
		tools?: string[];
	}

	interface ModelEntry {
		id: string;
		provider?: string;
		tags?: string[];
	}

	interface KeyEntry {
		id: string;
		provider?: string;
		status?: string;
		lastError?: string;
		exhaustedAt?: string;
	}

	interface ConfigData {
		agents?: Record<string, AgentTemplate>;
		models?: Record<string, { provider?: string; tags?: string[] }>;
		keys?: Record<string, { env?: string }>;
		fallback?: string[];
		permissions?: Record<string, unknown>;
	}

	interface ModelsData {
		models?: ModelEntry[];
		tags?: Record<string, string[]>;
		keys?: KeyEntry[];
	}

	const { apiBase }: { apiBase: string } = $props();

	let configData = $state<ConfigData | null>(null);
	let modelsData = $state<ModelsData | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function fetchData() {
		loading = true;
		error = null;
		try {
			const [configRes, modelsRes] = await Promise.all([
				fetch(`${apiBase}/config`),
				fetch(`${apiBase}/models`),
			]);
			if (!configRes.ok) throw new Error(`/config returned ${configRes.status}`);
			if (!modelsRes.ok) throw new Error(`/models returned ${modelsRes.status}`);
			const configJson = await configRes.json();
			const modelsJson = await modelsRes.json();
			configData = configJson.config ?? configJson;
			modelsData = modelsJson;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		fetchData();
	});

	const modelCount = $derived(modelsData?.models?.length ?? 0);
	const keyCount = $derived(modelsData?.keys?.length ?? 0);

	function formatDate(iso: string | undefined): string {
		if (!iso) return "";
		try {
			return new Date(iso).toLocaleString();
		} catch {
			return iso;
		}
	}

	function permissionEntries(permissions: Record<string, unknown>): Array<{ name: string; value: unknown }> {
		return Object.entries(permissions).map(([name, value]) => ({ name, value }));
	}

	function isSimpleRule(value: unknown): value is { action: string } {
		return typeof value === "object" && value !== null && "action" in value && Object.keys(value).length === 1;
	}

	function isPatternRule(value: unknown): value is Record<string, { action: string }> {
		return typeof value === "object" && value !== null && !("action" in value);
	}
</script>

<details class="collapse collapse-arrow bg-base-200 mt-2">
	<summary class="collapse-title text-sm font-medium flex items-center gap-2">
		<span>Configuration</span>
		{#if modelCount > 0 || keyCount > 0}
			<span class="badge badge-sm badge-neutral">{modelCount} models</span>
			<span class="badge badge-sm badge-neutral">{keyCount} keys</span>
		{/if}
		{#if loading}
			<span class="loading loading-spinner loading-xs ml-auto"></span>
		{/if}
	</summary>

	<div class="collapse-content text-xs">
		{#if error}
			<div class="alert alert-error alert-sm py-1 mb-2 text-xs">
				<span>Failed to load config: {error}</span>
			</div>
		{/if}

		<div class="flex justify-end mb-2">
			<button
				type="button"
				class="btn btn-xs btn-ghost"
				onclick={fetchData}
				disabled={loading}
			>
				{loading ? "Loading…" : "Refresh"}
			</button>
		</div>

		<!-- Agent Templates -->
		{#if configData?.agents && Object.keys(configData.agents).length > 0}
			<div class="mb-3">
				<div class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-1">Agent Templates</div>
				{#each Object.entries(configData.agents) as [name, template]}
					<div class="bg-base-100 rounded p-2 mb-1">
						<div class="flex items-center gap-2 flex-wrap">
							<span class="font-medium">{name}</span>
							{#if template.model_tag}
								<span class="badge badge-xs badge-info">{template.model_tag}</span>
							{/if}
						</div>
						{#if template.description}
							<p class="text-base-content/60 mt-0.5">{template.description}</p>
						{/if}
						{#if template.tools && template.tools.length > 0}
							<div class="flex flex-wrap gap-1 mt-1">
								{#each template.tools as tool}
									<span class="badge badge-xs badge-ghost">{tool}</span>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Models -->
		{#if modelsData?.models && modelsData.models.length > 0}
			<div class="mb-3">
				<div class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-1">Models</div>
				{#each modelsData.models as model}
					<div class="flex items-center gap-2 flex-wrap py-0.5 border-b border-base-300">
						<span class="font-mono">{model.id}</span>
						{#if model.provider}
							<span class="badge badge-xs badge-primary">{model.provider}</span>
						{/if}
						{#if model.tags && model.tags.length > 0}
							{#each model.tags as tag}
								<span class="badge badge-xs badge-ghost">{tag}</span>
							{/each}
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Keys -->
		{#if modelsData?.keys && modelsData.keys.length > 0}
			<div class="mb-3">
				<div class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-1">API Keys</div>
				{#each modelsData.keys as key}
					<div class="bg-base-100 rounded p-1.5 mb-1">
						<div class="flex items-center gap-2 flex-wrap">
							<span class="font-mono">{key.id}</span>
							{#if key.provider}
								<span class="badge badge-xs badge-secondary">{key.provider}</span>
							{/if}
							{#if key.status === "exhausted"}
								<span class="badge badge-xs badge-error">exhausted</span>
							{:else}
								<span class="badge badge-xs badge-success">active</span>
							{/if}
						</div>
						{#if key.status === "exhausted" && key.lastError}
							<p class="text-error/80 mt-0.5 truncate">{key.lastError}</p>
						{/if}
						{#if key.exhaustedAt}
							<p class="text-base-content/40 mt-0.5">Since {formatDate(key.exhaustedAt)}</p>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<!-- Fallback Order -->
		{#if configData?.fallback && configData.fallback.length > 0}
			<div class="mb-3">
				<div class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-1">Fallback Order</div>
				<ol class="list-none space-y-0.5">
					{#each configData.fallback as keyId, i}
						<li class="flex items-center gap-2">
							<span class="badge badge-xs badge-outline">{i + 1}</span>
							<span class="font-mono">{keyId}</span>
						</li>
					{/each}
				</ol>
			</div>
		{/if}

		<!-- Permissions -->
		{#if configData?.permissions && Object.keys(configData.permissions).length > 0}
			<div class="mb-1">
				<div class="text-xs font-semibold text-base-content/60 uppercase tracking-wide mb-1">Permissions</div>
				{#each permissionEntries(configData.permissions) as entry}
					<div class="py-0.5 border-b border-base-300">
						<span class="font-medium text-base-content/80">{entry.name}</span>
						{#if isSimpleRule(entry.value)}
							<span class="ml-2 badge badge-xs {entry.value.action === 'allow' ? 'badge-success' : 'badge-error'}">{entry.value.action}</span>
						{:else if isPatternRule(entry.value)}
							{#each Object.entries(entry.value) as [pattern, rule]}
								<div class="pl-2 flex items-center gap-2">
									<span class="text-base-content/50 font-mono truncate max-w-32">{pattern}</span>
									{#if typeof rule === "object" && rule !== null && "action" in rule}
										<span class="badge badge-xs {(rule as { action: string }).action === 'allow' ? 'badge-success' : 'badge-error'}">{(rule as { action: string }).action}</span>
									{/if}
								</div>
							{/each}
						{:else}
							<span class="text-base-content/40 ml-2">{JSON.stringify(entry.value)}</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{#if !loading && !error && !configData && !modelsData}
			<p class="text-base-content/40 italic">No configuration loaded.</p>
		{/if}
	</div>
</details>
