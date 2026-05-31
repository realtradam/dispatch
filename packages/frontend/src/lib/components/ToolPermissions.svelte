<script lang="ts">
import { onMount } from "svelte";
import { appSettings } from "../settings.svelte.js";
import type { LogEntry } from "../types.js";

interface ToolPermission {
	id: string;
	label: string;
	description: string;
}

const toolPermissions: ToolPermission[] = [
	{ id: "read", label: "Read files", description: "Allow the AI to read files in the workspace" },
	{
		id: "edit",
		label: "Edit files",
		description: "Allow the AI to write/edit files in the workspace",
	},
	{ id: "bash", label: "Run commands", description: "Allow the AI to execute shell commands" },
	{
		id: "summon",
		label: "Summon agents",
		description: "Allow the AI to spawn child agents to work on tasks",
	},
	{
		id: "user_agent",
		label: "Spawn user agents",
		description: "Allow the AI to open new independent top-level tabs",
	},
	{
		id: "web_search",
		label: "Web search",
		description: "Allow the AI to search the web via Firecrawl",
	},
	{
		id: "youtube_transcribe",
		label: "YouTube transcripts",
		description: "Allow the AI to fetch YouTube video transcripts",
	},
];

const {
	entries = [],
	apiBase = "",
	checkedTools = null,
	onToolToggle = null,
}: {
	entries?: LogEntry[];
	apiBase?: string;
	/** External checked set (agent builder mode). When null, uses appSettings. */
	checkedTools?: Set<string> | null;
	/** Callback when a tool is toggled in external mode. */
	onToolToggle?: ((id: string, checked: boolean) => void) | null;
} = $props();

/** Whether we're in external (agent builder) mode */
const externalMode = $derived(checkedTools !== null && onToolToggle !== null);

function isChecked(id: string): boolean {
	if (externalMode) return checkedTools?.has(id) ?? false;
	return appSettings.toolPerms[id] === true;
}

async function loadPermissions(): Promise<void> {
	const loaded: Record<string, boolean> = { ...appSettings.toolPerms };
	for (const perm of toolPermissions) {
		try {
			const res = await fetch(`${apiBase}/tabs/settings/perm_${perm.id}`);
			if (res.ok) {
				const data = (await res.json()) as { value: string | null };
				if (data.value !== null) {
					loaded[perm.id] = data.value === "allow";
				}
			}
		} catch {
			// ignore
		}
	}
	appSettings.toolPerms = { ...loaded };
	appSettings.savedToolPerms = { ...loaded };
}

function togglePermission(id: string): void {
	if (externalMode) {
		onToolToggle?.(id, !checkedTools?.has(id));
		return;
	}
	appSettings.toolPerms = { ...appSettings.toolPerms, [id]: !appSettings.toolPerms[id] };
}

function resetPermissions(): void {
	appSettings.toolPerms = { ...appSettings.savedToolPerms };
}

onMount(() => {
	if (!externalMode) {
		loadPermissions();
	}
});
</script>

<div class="flex flex-col gap-3">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Tool Permissions</div>
	{#if !externalMode}
		<p class="text-xs text-base-content/40">Changes are applied when you send your next message.</p>
	{/if}

	<div class="flex flex-col gap-1.5">
		{#each toolPermissions as perm (perm.id)}
			<label class="flex items-start gap-2 cursor-pointer p-1 rounded hover:bg-base-200 transition-colors">
				<input
					type="checkbox"
					class="checkbox checkbox-sm rounded-sm mt-0.5"
					checked={isChecked(perm.id)}
					onchange={() => togglePermission(perm.id)}
				/>
				<div class="flex flex-col">
					<span class="text-xs font-medium text-base-content">{perm.label}</span>
					<span class="text-xs text-base-content/40">{perm.description}</span>
				</div>
			</label>
		{/each}
	</div>

	{#if !externalMode}
		<button
			class="btn btn-sm btn-ghost w-full"
			disabled={!appSettings.toolPermsDirty}
			onclick={resetPermissions}
		>
			Reset
		</button>

		<p class="text-xs text-base-content/40">Warning: changing tool access will reset the AI's prompt cache for active conversations, which may increase usage costs.</p>

		<!-- Permission Log -->
		{#if entries.length > 0}
			<div class="collapse collapse-arrow bg-base-200 mt-2">
				<input type="checkbox" />
				<div class="collapse-title text-sm font-medium py-2 min-h-0">
					Log ({entries.length})
				</div>
				<div class="collapse-content text-xs max-h-40 overflow-y-auto">
					{#each entries as entry (entry.id)}
						<div class="flex items-center gap-2 py-1 border-b border-base-300">
							<span class="badge badge-sm {entry.action === 'reject' ? 'badge-error' : 'badge-success'}">
								{entry.action}
							</span>
							<span class="text-base-content/70">{entry.permission}</span>
							<span class="text-base-content/50 ml-auto text-xs">{entry.timestamp}</span>
						</div>
						<p class="text-base-content/60 pl-2 pb-1">{entry.description}</p>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
