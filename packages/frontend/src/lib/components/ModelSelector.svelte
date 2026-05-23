<script module lang="ts">
const modelCache = new Map<string, string[]>();
</script>

<script lang="ts">
	import type { KeyInfo } from "../types.js";
	import { config } from "../config.js";
	import { router } from "../router.svelte.js";

	interface AgentInfo {
		name: string;
		slug: string;
		scope: string;
		description: string;
		skills: string[];
		tools: string[];
		models: Array<{ key_id: string; model_id: string }>;
		cwd?: string;
		is_subagent?: boolean;
	}

	// Moves an element to document.body so modals escape the sidebar's
	// transform stacking context and cover the full viewport.
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}

	const {
		keys = [],
		activeKeyId = null,
		activeModelId = null,
		reasoningEffort = "max",
		activeAgentSlug = null,
		workingDirectory = null,
		onKeyChange,
		onModelChange,
		onReasoningChange,
		onAgentChange = (_agent: AgentInfo | null) => {},
		onWorkingDirectoryChange = (_dir: string | null) => {},
	}: {
		keys?: KeyInfo[];
		activeKeyId?: string | null;
		activeModelId?: string | null;
		reasoningEffort?: string;
		activeAgentSlug?: string | null;
		workingDirectory?: string | null;
		onKeyChange: (keyId: string) => void;
		onModelChange: (keyId: string, modelId: string) => void;
		onReasoningChange: (effort: string) => void;
		onAgentChange?: (agent: AgentInfo | null) => void;
		onWorkingDirectoryChange?: (dir: string | null) => void;
	} = $props();

	let showKeyModal = $state(false);
	let showModelModal = $state(false);
	let availableModels = $state<string[]>([]);
	let loadingModels = $state(false);
	let modelError = $state<string | null>(null);
	let sliderDragging = $state<number | null>(null);

	let cwdExists = $state<boolean | null>(null);
	let cwdCheckTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		const cwd = workingDirectory;
		if (!cwd) {
			cwdExists = null;
			return;
		}
		cwdExists = null;
		if (cwdCheckTimer) clearTimeout(cwdCheckTimer);
		cwdCheckTimer = setTimeout(async () => {
			try {
				const res = await fetch(
					`${config.apiBase}/agents/check-dir?path=${encodeURIComponent(cwd)}`,
				);
				if (res.ok) {
					const data = await res.json();
					cwdExists = data.exists ?? false;
				}
			} catch {
				cwdExists = null;
			}
		}, 300);
	});

	let modeOverride = $state<"manual" | "agent" | null>(null);
	let mode = $derived(modeOverride ?? (activeAgentSlug ? "agent" : "manual"));
	let agents = $state<AgentInfo[]>([]);
	let visibleAgents = $derived(agents.filter((a) => !a.is_subagent));
	let loadingAgents = $state(false);

	$effect(() => {
		fetchAgents();
	});

	async function fetchAgents() {
		loadingAgents = true;
		try {
			const res = await fetch(`${config.apiBase}/agents`);
			if (res.ok) {
				const data = await res.json();
				agents = data.agents ?? [];
			}
		} catch {
			/* ignore */
		} finally {
			loadingAgents = false;
		}
	}

	function selectKey(keyId: string) {
		showKeyModal = false;
		onKeyChange(keyId);
		// Immediately open model selection for the new key
		openModelModal(keyId);
	}

	async function openModelModal(keyIdOverride?: string) {
		const keyId = keyIdOverride ?? activeKeyId;
		if (!keyId) return;
		showModelModal = true;
		modelError = null;

		// Check session cache
		if (modelCache.has(keyId)) {
			availableModels = modelCache.get(keyId)!;
			loadingModels = false;
			return;
		}

		loadingModels = true;
		availableModels = [];

		try {
			const res = await fetch(
				`${config.apiBase}/models/available?keyId=${encodeURIComponent(keyId)}`,
			);
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				modelError = data.error ?? `Failed to fetch models (HTTP ${res.status})`;
				return;
			}
			const data = await res.json();
			availableModels = data.models ?? [];
			// Cache for session
			modelCache.set(keyId, availableModels);
		} catch (err) {
			modelError = err instanceof Error ? err.message : "Failed to fetch models";
		} finally {
			loadingModels = false;
		}
	}

	function selectModel(model: string) {
		showModelModal = false;
		if (activeKeyId) {
			onModelChange(activeKeyId, model);
		}
	}
</script>

<div class="bg-base-200 rounded-lg p-3">
	<!-- Working Directory -->
	<div class="form-control mb-3">
		<label class="label py-0" for="cwd-input">
			<span class="label-text text-xs font-semibold">Working Directory</span>
		</label>
		<div class="flex items-center gap-1.5 mt-1">
			<input
				id="cwd-input"
				type="text"
				class="input input-bordered input-sm font-mono text-xs flex-1"
				placeholder="default (project root)"
				value={workingDirectory ?? ""}
				onchange={(e) => {
					const val = e.currentTarget.value.trim();
					onWorkingDirectoryChange(val || null);
				}}
			/>
			{#if workingDirectory}
				{#if cwdExists === true}
					<span class="text-success text-sm" title="Directory exists">&#x2714;</span>
				{:else if cwdExists === false}
					<span class="text-warning text-sm" title="Will be created">&#x2716;</span>
				{:else}
					<span class="loading loading-spinner loading-xs"></span>
				{/if}
			{/if}
		</div>
	</div>

	<!-- Toggle -->
	<div class="flex items-center gap-2 mb-3">
		<button
			class="btn btn-xs {mode === 'manual' ? 'btn-primary' : 'btn-ghost'}"
			onclick={() => { modeOverride = "manual"; onAgentChange(null); }}
		>
			Manual
		</button>
		<button
			class="btn btn-xs {mode === 'agent' ? 'btn-primary' : 'btn-ghost'}"
			onclick={async () => {
				modeOverride = "agent";
				await fetchAgents();
				// Re-apply the active agent's settings (including cwd)
				const current = visibleAgents.find(a => a.slug === activeAgentSlug);
				const agentToApply = current ?? visibleAgents[0] ?? null;
				if (agentToApply) {
					onAgentChange(agentToApply);
					// Force-update the input since the prop may not change (already set)
					const cwdEl = document.getElementById("cwd-input") as HTMLInputElement | null;
					if (cwdEl) cwdEl.value = agentToApply.cwd ?? "";
				}
			}}
		>
			Agent
		</button>
	</div>

	{#if mode === "manual"}
		<div class="flex items-center justify-between">
			<span class="text-sm font-medium">Key</span>
			<button class="btn btn-sm btn-outline" onclick={() => (showKeyModal = true)}>
				{activeKeyId ?? "Select Key"}
			</button>
		</div>

		<div class="flex items-center justify-between mt-2">
			<span class="text-sm font-medium">Model</span>
			<button class="btn btn-sm btn-outline" onclick={() => openModelModal()} disabled={!activeKeyId}>
				{activeModelId ?? "Select Model"}
			</button>
		</div>

		{#if activeModelId}
			<div class="flex items-center justify-between mt-2">
				<span class="text-sm font-medium">Thinking</span>
				<select
					class="select select-bordered select-sm"
					value={reasoningEffort}
					onchange={(e) => onReasoningChange(e.currentTarget.value)}
				>
					<option value="none">Off</option>
					<option value="low">Low</option>
					<option value="medium">Medium</option>
					<option value="high">High</option>
					<option value="max">Max</option>
				</select>
			</div>
		{/if}
	{:else}
		<!-- Agent selection UI -->
		{#if loadingAgents}
			<div class="flex items-center gap-2 py-2 text-base-content/60">
				<span class="loading loading-spinner loading-xs"></span>
				Loading agents...
			</div>
		{:else if visibleAgents.length === 0}
			<p class="text-base-content/50 text-sm py-2">No agents configured.</p>
		{:else}
			<div class="flex flex-col gap-1.5">
				{#each visibleAgents as agent (agent.slug + ":" + agent.scope)}
					{@const isActive = activeAgentSlug === agent.slug}
					{@const hasMultipleModels = agent.models.length > 1}
					{@const currentIdx = isActive
						? agent.models.findIndex(
								(m) => m.key_id === activeKeyId && m.model_id === activeModelId,
							)
						: -1}
					<div
						role="button"
						tabindex="0"
						class="w-full text-left rounded-lg px-3 py-2 transition-colors {isActive ? 'bg-primary text-primary-content' : 'bg-base-300 hover:bg-base-200'}"
						onclick={() => {
							// Only switch agent — don't reset the slider position
							onAgentChange(agent);
							const cwdEl = document.getElementById("cwd-input") as HTMLInputElement | null;
							if (cwdEl) cwdEl.value = agent.cwd ?? "";
						}}
						onkeydown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onAgentChange(agent);
								const cwdEl = document.getElementById("cwd-input") as HTMLInputElement | null;
								if (cwdEl) cwdEl.value = agent.cwd ?? "";
							}
						}}
					>
						<div class="flex items-center justify-between gap-2">
							<span class="font-medium text-sm">{agent.name}</span>
							<div class="flex gap-1 shrink-0">
								<span class="badge badge-xs">{agent.models.length} model{agent.models.length !== 1 ? "s" : ""}</span>
								<span class="badge badge-xs badge-outline">{agent.scope === "global" ? "global" : "project"}</span>
							</div>
						</div>
						{#if agent.description}
							<p class="text-xs opacity-60 mt-0.5">{agent.description}</p>
						{/if}
						{#if isActive && hasMultipleModels}
							{@const displayIdx = sliderDragging !== null ? sliderDragging : (currentIdx >= 0 ? currentIdx : 0)}
							{@const displayModel = agent.models[displayIdx]}
							<div class="mt-2 pt-2 border-t border-primary-content/20">
								<div class="text-xs font-semibold mb-1 truncate">
									{displayModel ? `${displayModel.key_id} / ${displayModel.model_id}` : `${activeKeyId} / ${activeModelId}`}
								</div>
								<input
									type="range"
									min="0"
									max={agent.models.length - 1}
									value={currentIdx >= 0 ? currentIdx : 0}
									class="range range-xs"
									step="1"
									oninput={(e) => {
										sliderDragging = Number(e.currentTarget.value);
									}}
									onchange={(e) => {
										const idx = Number(e.currentTarget.value);
										const m = agent.models[idx];
										if (m) onModelChange(m.key_id, m.model_id);
										sliderDragging = null;
									}}
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => e.stopPropagation()}
								/>
								<div class="flex w-full justify-between px-0.5 text-xs opacity-50 mt-0.5">
									{#each agent.models as _, i}
										<span>{i + 1}</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<button
			type="button"
			class="btn btn-outline btn-sm w-full mt-2 hover:bg-base-300 hover:border-base-300 text-base-content/60"
			onclick={() => router.navigate("agent-builder")}
		>
			Agent Settings
		</button>
	{/if}
</div>

{#if showKeyModal}
	<div class="modal modal-open" use:portal>
		<div class="modal-box">
			<h3 class="font-bold text-xl">Select Key</h3>
			<div class="mt-4 flex flex-col gap-2">
				{#each keys as key}
					<button
						class="btn {key.id === activeKeyId
							? 'btn-primary'
							: 'btn-ghost'} justify-start text-base"
						onclick={() => selectKey(key.id)}
					>
						<span class="font-mono">{key.id}</span>
						<span class="badge ml-auto">{key.provider}</span>
						<span
							class="badge {key.status === 'active'
								? 'badge-success'
								: 'badge-error'}">{key.status}</span
						>
					</button>
				{/each}
			</div>
			<div class="modal-action">
				<button class="btn" onclick={() => (showKeyModal = false)}>Cancel</button>
			</div>
		</div>
		<button type="button" class="modal-backdrop" onclick={() => (showKeyModal = false)} aria-label="Close modal"></button>
	</div>
{/if}

{#if showModelModal}
	<div class="modal modal-open" use:portal>
		<div class="modal-box">
			<h3 class="font-bold text-xl">Select Model</h3>
			{#if loadingModels}
				<div class="flex justify-center py-8">
					<span class="loading loading-spinner loading-lg"></span>
				</div>
			{:else if modelError}
				<div class="alert alert-error mt-4 text-base">
					<span>{modelError}</span>
				</div>
			{:else}
				<div class="mt-4 flex flex-col gap-1 max-h-96 overflow-y-auto">
					{#each availableModels as model}
						<button
							class="btn {model === activeModelId
								? 'btn-primary'
								: 'btn-ghost'} justify-start font-mono text-base"
							onclick={() => selectModel(model)}
						>
							{model}
						</button>
					{/each}
				</div>
			{/if}
			<div class="modal-action">
				<button class="btn" onclick={() => (showModelModal = false)}>Cancel</button>
			</div>
		</div>
		<button type="button" class="modal-backdrop" onclick={() => (showModelModal = false)} aria-label="Close modal"></button>
	</div>
{/if}
