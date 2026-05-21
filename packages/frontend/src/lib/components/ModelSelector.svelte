<script module>
	const modelCache = new Map<string, string[]>();
</script>

<script lang="ts">
	import type { KeyInfo } from "../types.js";
	import { config } from "../config.js";

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
		onKeyChange,
		onModelChange,
		onReasoningChange,
	}: {
		keys?: KeyInfo[];
		activeKeyId?: string | null;
		activeModelId?: string | null;
		reasoningEffort?: string;
		onKeyChange: (keyId: string) => void;
		onModelChange: (keyId: string, modelId: string) => void;
		onReasoningChange: (effort: string) => void;
	} = $props();

	let showKeyModal = $state(false);
	let showModelModal = $state(false);
	let availableModels = $state<string[]>([]);
	let loadingModels = $state(false);
	let modelError = $state<string | null>(null);

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
