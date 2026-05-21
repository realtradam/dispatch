<script lang="ts">
	import type { KeyInfo } from "../types.js";

	const {
		keys = [],
		apiBase = "",
	}: {
		keys?: KeyInfo[];
		apiBase?: string;
	} = $props();

	let titleKeyId = $state<string | null>(null);
	let titleModelId = $state<string | null>(null);
	let availableModels = $state<string[]>([]);
	let loadingModels = $state(false);
	let saving = $state(false);
	let saved = $state(false);

	async function loadSettings(): Promise<void> {
		try {
			const res = await fetch(`${apiBase}/tabs/settings/title-model`);
			if (!res.ok) return;
			const data = await res.json() as { keyId: string | null; modelId: string | null };
			titleKeyId = data.keyId;
			if (titleKeyId) {
				await loadModelsForKey(titleKeyId);
			}
			// Set model AFTER options are loaded so the select can match the value
			titleModelId = data.modelId;
		} catch {
			// ignore
		}
	}

	async function loadModelsForKey(keyId: string): Promise<void> {
		loadingModels = true;
		try {
			const res = await fetch(`${apiBase}/models/available?keyId=${encodeURIComponent(keyId)}`);
			if (!res.ok) { availableModels = []; return; }
			const data = await res.json() as { models: string[] };
			availableModels = data.models ?? [];
		} catch {
			availableModels = [];
		} finally {
			loadingModels = false;
		}
	}

	async function onKeyChange(e: Event): Promise<void> {
		const select = e.target as HTMLSelectElement;
		titleKeyId = select.value || null;
		titleModelId = null;
		availableModels = [];
		if (titleKeyId) {
			await loadModelsForKey(titleKeyId);
		}
	}

	async function onModelChange(e: Event): Promise<void> {
		const select = e.target as HTMLSelectElement;
		titleModelId = select.value || null;
	}

	async function saveSettings(): Promise<void> {
		saving = true;
		try {
			await fetch(`${apiBase}/tabs/settings/title-model`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ keyId: titleKeyId, modelId: titleModelId }),
			});
			saved = true;
			setTimeout(() => { saved = false; }, 2000);
		} catch {
			// ignore
		} finally {
			saving = false;
		}
	}

	$effect(() => {
		void loadSettings();
	});
</script>

<div class="flex flex-col gap-3">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Settings</div>

	<div class="flex flex-col gap-2">
		<p class="text-xs text-base-content/70">Title Generation Model</p>
		<p class="text-xs text-base-content/40">Used to generate short titles for new tabs after the first message.</p>

		<label class="text-xs text-base-content/60">Key</label>
		<select class="select select-bordered select-sm w-full" onchange={onKeyChange} value={titleKeyId ?? ""}>
			<option value="">Select a key...</option>
			{#each keys as key (key.id)}
				<option value={key.id}>{key.id} ({key.provider})</option>
			{/each}
		</select>

		<label class="text-xs text-base-content/60">Model</label>
		<select
			class="select select-bordered select-sm w-full"
			onchange={onModelChange}
			value={titleModelId ?? ""}
			disabled={!titleKeyId || loadingModels}
		>
			<option value="">{loadingModels ? "Loading models..." : "Select a model..."}</option>
			{#each availableModels as model (model)}
				<option value={model}>{model}</option>
			{/each}
		</select>

		<button
			class="btn btn-sm btn-primary w-full mt-1"
			disabled={saving || !titleKeyId || !titleModelId}
			onclick={saveSettings}
		>
			{#if saving}
				<span class="loading loading-spinner loading-xs"></span>
			{:else if saved}
				Saved
			{:else}
				Save
			{/if}
		</button>
	</div>
</div>
