<script lang="ts">
import { onMount } from "svelte";
import { appSettings } from "../settings.svelte.js";
import type { LogEntry } from "../types.js";

const { entries, apiBase = "" }: { entries: LogEntry[]; apiBase?: string } = $props();

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
		id: "external_directory",
		label: "External directories",
		description: "Allow access to files outside the workspace",
	},
];

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
	appSettings.toolPerms = { ...appSettings.toolPerms, [id]: !appSettings.toolPerms[id] };
}

function resetPermissions(): void {
	appSettings.toolPerms = { ...appSettings.savedToolPerms };
}

onMount(() => {
	loadPermissions();
});
</script>

<div class="flex flex-col gap-3">
	<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Tool Permissions</div>
	<p class="text-xs text-base-content/40">Changes are applied when you send your next message.</p>

	<div class="flex flex-col gap-1.5">
		{#each toolPermissions as perm (perm.id)}
			<label class="flex items-start gap-2 cursor-pointer p-1 rounded hover:bg-base-200 transition-colors">
				<input
					type="checkbox"
					class="checkbox checkbox-sm rounded-sm mt-0.5"
					checked={appSettings.toolPerms[perm.id]}
					onchange={() => togglePermission(perm.id)}
				/>
				<div class="flex flex-col">
					<span class="text-xs font-medium text-base-content">{perm.label}</span>
					<span class="text-xs text-base-content/40">{perm.description}</span>
				</div>
			</label>
		{/each}
	</div>

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
</div>
