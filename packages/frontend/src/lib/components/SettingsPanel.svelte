<script lang="ts">
import { appSettings } from "../settings.svelte.js";
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
let autoExpandThinking = $state(appSettings.autoExpandThinking);

async function loadSettings(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/tabs/settings/title-model`);
		if (res.ok) {
			const data = (await res.json()) as { keyId: string | null; modelId: string | null };
			titleKeyId = data.keyId;
			if (titleKeyId) {
				await loadModelsForKey(titleKeyId);
			}
			titleModelId = data.modelId;
		}
	} catch {
		// ignore
	}
	try {
		const res = await fetch(`${apiBase}/tabs/settings/auto-expand-thinking`);
		if (res.ok) {
			const data = (await res.json()) as { value: string | null };
			autoExpandThinking = data.value === "true";
			appSettings.autoExpandThinking = autoExpandThinking;
		}
	} catch {
		// ignore
	}
}

async function toggleAutoExpand(): Promise<void> {
	autoExpandThinking = !autoExpandThinking;
	appSettings.autoExpandThinking = autoExpandThinking;
	fetch(`${apiBase}/tabs/settings/auto-expand-thinking`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ value: String(autoExpandThinking) }),
	}).catch(() => {});
}

async function loadModelsForKey(keyId: string): Promise<void> {
	loadingModels = true;
	try {
		const res = await fetch(`${apiBase}/models/available?keyId=${encodeURIComponent(keyId)}`);
		if (!res.ok) {
			availableModels = [];
			return;
		}
		const data = (await res.json()) as { models: string[] };
		availableModels = data.models ?? [];
	} catch {
		availableModels = [];
	} finally {
		loadingModels = false;
	}
}

function saveTitleModel(): void {
	fetch(`${apiBase}/tabs/settings/title-model`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keyId: titleKeyId, modelId: titleModelId }),
	}).catch(() => {});
}

async function onKeyChange(e: Event): Promise<void> {
	const select = e.target as HTMLSelectElement;
	titleKeyId = select.value || null;
	titleModelId = null;
	availableModels = [];
	if (titleKeyId) {
		await loadModelsForKey(titleKeyId);
	}
	saveTitleModel();
}

async function onModelChange(e: Event): Promise<void> {
	const select = e.target as HTMLSelectElement;
	titleModelId = select.value || null;
	saveTitleModel();
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

		<label class="text-xs text-base-content/60">
			Key
			<select class="select select-bordered select-sm w-full" onchange={onKeyChange} value={titleKeyId ?? ""}>
				<option value="">Select a key...</option>
				{#each keys as key (key.id)}
					<option value={key.id}>{key.id} ({key.provider})</option>
				{/each}
			</select>
		</label>

		<label class="text-xs text-base-content/60">
			Model
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
		</label>

		<div class="divider my-0"></div>

		<p class="text-xs text-base-content/70">Chat</p>
		<label class="flex items-center gap-2 cursor-pointer">
			<input
				type="checkbox"
				class="checkbox checkbox-sm rounded-sm"
				checked={autoExpandThinking}
				onchange={toggleAutoExpand}
			/>
			<span class="text-xs text-base-content/70">Auto-expand thinking</span>
		</label>
	</div>
</div>
