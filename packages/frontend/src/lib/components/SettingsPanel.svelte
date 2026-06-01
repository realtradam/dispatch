<script lang="ts">
import { config } from "../config.js";
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
let localChunkLimit = $state(appSettings.chunkLimit);
let backendUrl = $state(config.apiBase);
let backendUrlSaved = $state(false);

// ─── ntfy.sh push notifications ──────────────────────────────────
// Server-side schema mirror — kept inline rather than imported to avoid
// pulling a node-only barrel into the browser bundle (frontend already
// hand-mirrors a few core types in lib/types.ts for the same reason).
type NotificationEventType =
	| "turn-completed"
	| "turn-error"
	| "permission-required"
	| "agent-spawned";

interface NtfyConfigView {
	enabled: boolean;
	topicUrl: string;
	authToken: string;
	hasAuthToken?: boolean;
	events: Record<NotificationEventType, boolean>;
	notifySubagents: boolean;
}

const NTFY_EVENT_LABELS: Record<NotificationEventType, string> = {
	"turn-completed": "Turn completed",
	"turn-error": "Turn error",
	"permission-required": "Permission requested",
	"agent-spawned": "User agent spawned",
};

const DEFAULT_NTFY: NtfyConfigView = {
	enabled: false,
	topicUrl: "",
	authToken: "",
	hasAuthToken: false,
	events: {
		"turn-completed": true,
		"turn-error": true,
		"permission-required": true,
		"agent-spawned": false,
	},
	notifySubagents: false,
};

let ntfy = $state<NtfyConfigView>({ ...DEFAULT_NTFY, events: { ...DEFAULT_NTFY.events } });
let ntfyAuthTokenInput = $state(""); // empty == leave unchanged on save
let ntfyEventOrder = $state<NotificationEventType[]>([
	"turn-completed",
	"turn-error",
	"permission-required",
	"agent-spawned",
]);
let ntfySaving = $state(false);
let ntfySaveError = $state<string | null>(null);
let ntfySaveOk = $state(false);
let ntfyTesting = $state(false);
let ntfyTestResult = $state<string | null>(null);
let ntfyTestOk = $state(false);
let ntfyClearingToken = $state(false);

function onChunkLimitChange(e: Event): void {
	const input = e.target as HTMLInputElement;
	const val = parseInt(input.value, 10);
	if (val >= 10 && val <= 2000) {
		appSettings.chunkLimit = val;
		localChunkLimit = val;
	}
}

function saveBackendUrl(): void {
	const trimmed = backendUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return;
	config.setApiBase(trimmed);
	backendUrl = trimmed;
	backendUrlSaved = true;
	setTimeout(() => {
		backendUrlSaved = false;
	}, 2000);
}

function resetBackendUrl(): void {
	config.setApiBase(config.defaultApiBase);
	backendUrl = config.defaultApiBase;
	backendUrlSaved = true;
	setTimeout(() => {
		backendUrlSaved = false;
	}, 2000);
}

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
	await loadNtfy();
}

async function loadNtfy(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/notifications`);
		if (!res.ok) return;
		const data = (await res.json()) as {
			config: NtfyConfigView;
			eventTypes?: NotificationEventType[];
		};
		ntfy = {
			...DEFAULT_NTFY,
			...data.config,
			events: { ...DEFAULT_NTFY.events, ...(data.config.events ?? {}) },
		};
		if (Array.isArray(data.eventTypes) && data.eventTypes.length > 0) {
			ntfyEventOrder = data.eventTypes;
		}
	} catch {
		// ignore
	}
}

async function saveNtfy(): Promise<void> {
	ntfySaving = true;
	ntfySaveError = null;
	ntfySaveOk = false;
	try {
		// `authToken: undefined` ⇒ server keeps the existing token.
		// `authToken: ""` ⇒ explicit clear (the user typed and cleared).
		const payload: Partial<NtfyConfigView> & { authToken?: string } = {
			enabled: ntfy.enabled,
			topicUrl: ntfy.topicUrl,
			events: ntfy.events,
			notifySubagents: ntfy.notifySubagents,
		};
		if (ntfyAuthTokenInput !== "") payload.authToken = ntfyAuthTokenInput;
		const res = await fetch(`${apiBase}/notifications`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const data = (await res.json()) as { config?: NtfyConfigView; error?: string };
		if (!res.ok) {
			ntfySaveError = data.error ?? `Save failed (HTTP ${res.status})`;
			return;
		}
		if (data.config) {
			ntfy = {
				...DEFAULT_NTFY,
				...data.config,
				events: { ...DEFAULT_NTFY.events, ...(data.config.events ?? {}) },
			};
		}
		ntfyAuthTokenInput = "";
		ntfySaveOk = true;
		setTimeout(() => {
			ntfySaveOk = false;
		}, 2000);
	} catch (e) {
		ntfySaveError = e instanceof Error ? e.message : "Network error";
	} finally {
		ntfySaving = false;
	}
}

async function sendNtfyTest(): Promise<void> {
	ntfyTesting = true;
	ntfyTestResult = null;
	ntfyTestOk = false;
	try {
		const res = await fetch(`${apiBase}/notifications/test`, { method: "POST" });
		const data = (await res.json()) as { ok?: boolean; error?: string; status?: number };
		if (!res.ok || !data.ok) {
			ntfyTestResult = data.error ?? `Test failed (HTTP ${res.status})`;
			return;
		}
		ntfyTestOk = true;
		ntfyTestResult = "Sent — check your ntfy client.";
	} catch (e) {
		ntfyTestResult = e instanceof Error ? e.message : "Network error";
	} finally {
		ntfyTesting = false;
	}
}

async function clearNtfyAuthToken(): Promise<void> {
	// `""` ⇒ explicit clear on save (vs. `undefined` which keeps existing).
	// Optimistic local state on failure caused a real bug pre-review: UI showed
	// the token cleared while the server still held it, then "Save" treated the
	// blank input as "keep existing" and silently re-armed the old token. Await
	// the response and only flip local state on success.
	ntfyClearingToken = true;
	ntfySaveError = null;
	try {
		const res = await fetch(`${apiBase}/notifications`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ authToken: "" }),
		});
		const data = (await res.json().catch(() => ({}))) as {
			config?: NtfyConfigView;
			error?: string;
		};
		if (!res.ok) {
			ntfySaveError = data.error ?? `Clear failed (HTTP ${res.status})`;
			return;
		}
		ntfyAuthTokenInput = "";
		if (data.config) {
			ntfy = {
				...DEFAULT_NTFY,
				...data.config,
				events: { ...DEFAULT_NTFY.events, ...(data.config.events ?? {}) },
			};
		} else {
			ntfy = { ...ntfy, hasAuthToken: false };
		}
	} catch (e) {
		ntfySaveError = e instanceof Error ? e.message : "Network error";
	} finally {
		ntfyClearingToken = false;
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

		<div class="divider my-0"></div>

		<p class="text-xs text-base-content/70">Memory</p>
		<label class="flex flex-col gap-1">
			<span class="text-xs text-base-content/70">
				Max chunks in memory: <span class="font-semibold">{localChunkLimit}</span>
			</span>
			<input
				type="range"
				min="20"
				max="1000"
				step="10"
				class="range range-xs"
				value={localChunkLimit}
				oninput={onChunkLimitChange}
			/>
			<span class="text-[10px] text-base-content/40">Lower = less RAM. Higher = less re-fetching.</span>
		</label>

		<div class="divider my-0"></div>

		<p class="text-xs text-base-content/70">Backend URL</p>
		<p class="text-xs text-base-content/40">API server address. Default: {config.defaultApiBase}</p>
		<div class="flex gap-1">
			<input
				type="text"
				class="input input-bordered input-sm flex-1"
				bind:value={backendUrl}
				placeholder={config.defaultApiBase}
			/>
			<button type="button" class="btn btn-sm btn-primary" onclick={saveBackendUrl}>
				Save
			</button>
		</div>
		<button
			type="button"
			class="btn btn-xs btn-ghost btn-outline w-full"
			disabled={config.apiBase === config.defaultApiBase}
			onclick={resetBackendUrl}
		>
			Reset to default
		</button>
		{#if backendUrlSaved}
			<p class="text-xs text-success">Saved. Reload the page to apply.</p>
		{/if}

		<div class="divider my-0"></div>

		<p class="text-xs text-base-content/70">Notifications (ntfy.sh)</p>
		<p class="text-xs text-base-content/40">
			Push notifications to your phone when things happen here. Subscribe to your topic in the
			<a href="https://ntfy.sh/" target="_blank" rel="noopener" class="link">ntfy.sh</a> app to receive them.
		</p>

		<label class="flex items-center gap-2 cursor-pointer">
			<input
				type="checkbox"
				class="checkbox checkbox-sm rounded-sm"
				bind:checked={ntfy.enabled}
			/>
			<span class="text-xs text-base-content/70">Enable notifications</span>
		</label>

		<label class="text-xs text-base-content/60 flex flex-col gap-1">
			Topic URL
			<input
				type="text"
				class="input input-bordered input-sm w-full"
				placeholder="https://ntfy.sh/your-secret-topic"
				bind:value={ntfy.topicUrl}
			/>
			<span class="text-[10px] text-base-content/40">
				Pick something unguessable — anyone with the URL can read your notifications.
			</span>
		</label>

		<label class="text-xs text-base-content/60 flex flex-col gap-1">
			Auth token (optional, for private ntfy servers)
			<input
				type="password"
				class="input input-bordered input-sm w-full"
				placeholder={ntfy.hasAuthToken ? "•••• (stored — type to replace)" : "Leave blank for public ntfy.sh"}
				bind:value={ntfyAuthTokenInput}
				autocomplete="off"
			/>
			{#if ntfy.hasAuthToken}
				<button
					type="button"
					class="btn btn-xs btn-ghost btn-outline self-start"
					disabled={ntfyClearingToken}
					onclick={clearNtfyAuthToken}
				>
					{#if ntfyClearingToken}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Clear stored token
					{/if}
				</button>
			{/if}
		</label>

		<div class="flex flex-col gap-1 mt-1">
			<span class="text-xs text-base-content/60">Notify me on:</span>
			{#each ntfyEventOrder as evType (evType)}
				<label class="flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						class="checkbox checkbox-sm rounded-sm"
						bind:checked={ntfy.events[evType]}
					/>
					<span class="text-xs text-base-content/70">{NTFY_EVENT_LABELS[evType] ?? evType}</span>
				</label>
			{/each}
		</div>

		<div class="flex flex-col gap-1 mt-1">
			<label class="flex items-center gap-2 cursor-pointer">
				<input
					type="checkbox"
					class="checkbox checkbox-sm rounded-sm"
					bind:checked={ntfy.notifySubagents}
				/>
				<span class="text-xs text-base-content/70">Include subagent tabs</span>
			</label>
			<span class="text-[10px] text-base-content/40 pl-6">
				Off (default): turn-completed/turn-error from subagents are suppressed. Permission prompts still fire so subagents don't silently hang.
			</span>
		</div>

		<div class="flex gap-1 mt-1">
			<button
				type="button"
				class="btn btn-sm btn-primary flex-1"
				disabled={ntfySaving}
				onclick={saveNtfy}
			>
				{#if ntfySaving}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					Save
				{/if}
			</button>
			<button
				type="button"
				class="btn btn-sm btn-outline"
				disabled={ntfyTesting || !ntfy.enabled}
				onclick={sendNtfyTest}
				title={ntfy.enabled ? "Send a test notification with current settings" : "Enable notifications first"}
			>
				{#if ntfyTesting}
					<span class="loading loading-spinner loading-xs"></span>
				{:else}
					Send test
				{/if}
			</button>
		</div>
		{#if ntfySaveOk}
			<p class="text-xs text-success">Saved.</p>
		{/if}
		{#if ntfySaveError}
			<p class="text-xs text-error">{ntfySaveError}</p>
		{/if}
		{#if ntfyTestResult}
			<p class="text-xs {ntfyTestOk ? 'text-success' : 'text-error'}">{ntfyTestResult}</p>
		{/if}
	</div>
</div>
