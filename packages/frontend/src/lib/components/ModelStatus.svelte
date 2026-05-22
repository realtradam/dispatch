<script lang="ts">
interface KeyInfo {
	id: string;
	provider: string;
	status: "active" | "exhausted";
	lastError: string | null;
	exhaustedAt: number | null;
}

interface CredentialStatus {
	keyId: string;
	provider: string;
	subscriptionType: string | null;
	importedAt: number;
	updatedAt: number;
	expired: boolean;
}

const {
	keys = [],
	currentModel,
	apiBase = "",
}: {
	keys?: KeyInfo[];
	currentModel?: string;
	apiBase?: string;
} = $props();

const activeKeys = $derived(keys.filter((k) => k.status === "active").length);
const totalKeys = $derived(keys.length);
const allActive = $derived(totalKeys > 0 && activeKeys === totalKeys);
const allExhausted = $derived(totalKeys > 0 && activeKeys === 0);
const someExhausted = $derived(totalKeys > 0 && activeKeys < totalKeys && activeKeys > 0);

let credentialStatus = $state<Record<string, CredentialStatus>>({});
let importingKey = $state<string | null>(null);
let importError = $state<string | null>(null);
let importSuccess = $state<string | null>(null);

let apiKeyStatus = $state<
	Record<string, { keyId: string; provider: string; importedAt: number; updatedAt: number }>
>({});
let showKeyModal = $state<string | null>(null); // keyId or null
let keyModalValue = $state("");
let keyModalError = $state<string | null>(null);
let keyModalSaving = $state(false);

async function loadCredentialStatus(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/credentials-status`);
		if (!res.ok) return;
		const data = (await res.json()) as { credentials: CredentialStatus[] };
		const map: Record<string, CredentialStatus> = {};
		for (const cred of data.credentials) {
			map[cred.keyId] = cred;
		}
		credentialStatus = map;
	} catch {
		// ignore
	}
}

async function importCredentials(keyId: string): Promise<void> {
	importingKey = keyId;
	importError = null;
	importSuccess = null;
	try {
		const res = await fetch(`${apiBase}/models/import-credentials`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId }),
		});
		const data = (await res.json()) as { success?: boolean; error?: string };
		if (!res.ok || !data.success) {
			importError = data.error ?? "Import failed";
		} else {
			importSuccess = keyId;
			await loadCredentialStatus();
			setTimeout(() => {
				importSuccess = null;
			}, 3000);
		}
	} catch (e) {
		importError = e instanceof Error ? e.message : "Network error";
	} finally {
		importingKey = null;
	}
}

async function loadApiKeyStatus(): Promise<void> {
	try {
		const res = await fetch(`${apiBase}/models/api-keys-status`);
		if (!res.ok) return;
		const data = (await res.json()) as {
			keys: Array<{ keyId: string; provider: string; importedAt: number; updatedAt: number }>;
		};
		const map: Record<string, (typeof data.keys)[0]> = {};
		for (const k of data.keys) {
			map[k.keyId] = k;
		}
		apiKeyStatus = map;
	} catch {
		// ignore
	}
}

async function saveApiKey(): Promise<void> {
	if (!showKeyModal || !keyModalValue.trim()) return;
	keyModalSaving = true;
	keyModalError = null;
	try {
		const res = await fetch(`${apiBase}/models/set-api-key`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId: showKeyModal, apiKey: keyModalValue.trim() }),
		});
		const data = (await res.json()) as { success?: boolean; error?: string };
		if (!res.ok || !data.success) {
			keyModalError = data.error ?? "Failed to save";
		} else {
			showKeyModal = null;
			keyModalValue = "";
			await loadApiKeyStatus();
		}
	} catch (e) {
		keyModalError = e instanceof Error ? e.message : "Network error";
	} finally {
		keyModalSaving = false;
	}
}

$effect(() => {
	void loadCredentialStatus();
	void loadApiKeyStatus();
});

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
	return str.length > max ? str.slice(0, max) + "..." : str;
}
</script>

<div class="flex flex-col gap-3">
	{#if keys.length === 0}
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

		<!-- Import error/success banners -->
		{#if importError}
			<div role="alert" class="text-xs text-error/80">{importError}</div>
		{/if}
		{#if importSuccess}
			<div class="text-xs text-success/80">Imported credentials for {importSuccess}</div>
		{/if}

		<!-- Keys -->
		{#if keys.length > 0}
			<div class="flex flex-col gap-1">
				<p class="text-xs text-base-content/50 uppercase tracking-wide">API Keys</p>
				<ul class="flex flex-col gap-1">
					{#each keys as key (key.id)}
						{@const cred = credentialStatus[key.id]}
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
							<!-- Credential import for anthropic keys -->
							{#if key.provider === "anthropic"}
								<div class="pl-2 flex items-center gap-1.5 mt-0.5">
									{#if cred}
										<span class="badge badge-xs {cred.expired ? 'badge-warning' : 'badge-info'}">
											{cred.expired ? "expired" : "imported"}
										</span>
										{#if cred.subscriptionType}
											<span class="text-xs text-base-content/40">{cred.subscriptionType}</span>
										{/if}
									{/if}
									<button
										type="button"
										class="btn btn-xs btn-ghost btn-outline"
										disabled={importingKey === key.id}
										onclick={() => importCredentials(key.id)}
									>
										{#if importingKey === key.id}
											<span class="loading loading-spinner loading-xs"></span>
										{:else}
											{cred ? "Re-import" : "Import Credentials"}
										{/if}
									</button>
								</div>
						{/if}
						<!-- API key import for env-based keys (opencode, copilot, etc) -->
						{#if key.provider !== "anthropic"}
							<div class="pl-2 flex items-center gap-1.5 mt-0.5">
								{#if apiKeyStatus[key.id]}
									<span class="badge badge-xs badge-info">imported</span>
								{/if}
								<button
									type="button"
									class="btn btn-xs btn-ghost btn-outline"
									onclick={() => { showKeyModal = key.id; keyModalValue = ""; keyModalError = null; }}
								>
									{apiKeyStatus[key.id] ? "Update Key" : "Import Key"}
								</button>
							</div>
						{/if}
					</li>
				{/each}
				</ul>
			</div>
		{/if}
	{/if}
<!-- Import Key Modal -->
{#if showKeyModal}
	<div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50" role="dialog">
		<div class="bg-base-100 rounded-lg p-4 w-80 flex flex-col gap-3 shadow-xl">
			<h3 class="text-sm font-semibold">Import Key: {showKeyModal}</h3>
			<input
				type="password"
				class="input input-bordered input-sm w-full"
				placeholder="Paste API key..."
				bind:value={keyModalValue}
			/>
			{#if keyModalError}
				<p class="text-xs text-error">{keyModalError}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<button
					type="button"
					class="btn btn-sm btn-ghost"
					onclick={() => { showKeyModal = null; keyModalValue = ""; keyModalError = null; }}
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn btn-sm btn-primary"
					disabled={!keyModalValue.trim() || keyModalSaving}
					onclick={saveApiKey}
				>
					{#if keyModalSaving}
						<span class="loading loading-spinner loading-xs"></span>
					{:else}
						Save
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}
</div>
