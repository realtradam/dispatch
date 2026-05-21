<script lang="ts">
	import ModelSelector from "./ModelSelector.svelte";
	import ModelStatus from "./ModelStatus.svelte";
	import TaskListPanel from "./TaskListPanel.svelte";
	import ConfigPanel from "./ConfigPanel.svelte";
	import SkillsBrowser from "./SkillsBrowser.svelte";
	import PermissionLog from "./PermissionLog.svelte";
	import KeyUsage from "./KeyUsage.svelte";
	import ClaudeReset from "./ClaudeReset.svelte";
	import type { TaskItem, LogEntry, KeyInfo, ModelInfo } from "../types.js";

	const {
		models = [],
		keys = [],
		tags = [],
		tasks = [],
		permissionLog = [],
		apiBase = "",
		activeKeyId = null,
		activeModelId = null,
		reasoningEffort = "max",
		onKeyChange,
		onModelChange,
		onReasoningChange,
	}: {
		models?: ModelInfo[];
		keys?: KeyInfo[];
		tags?: string[];
		tasks?: TaskItem[];
		permissionLog?: LogEntry[];
		apiBase?: string;
		activeKeyId?: string | null;
		activeModelId?: string | null;
		reasoningEffort?: string;
		onKeyChange: (keyId: string) => void;
		onModelChange: (keyId: string, modelId: string) => void;
		onReasoningChange: (effort: string) => void;
	} = $props();

	interface Panel {
		id: number;
		selected: string;
	}

	let nextId = 0;
	let panels = $state<Panel[]>([{ id: nextId++, selected: "Current Model" }]);

	const viewOptions = ["Select a view", "Current Model", "Key Usage", "Claude Reset", "Model Status", "Tasks", "Config", "Skills", "Permission Log"];

	function addPanel() {
		panels = [...panels, { id: nextId++, selected: "Select a view" }];
	}
</script>

<div class="flex flex-col gap-2 flex-1 min-h-0">
	{#each panels as panel, idx (panel.id)}
		<div class="bg-base-200 rounded-lg p-3 flex flex-col min-h-0 {idx > 0 ? 'flex-1' : 'flex-1'}">
			<select
				class="select select-bordered select-sm w-full"
				value={panel.selected}
				onchange={(e) => {
					panels = panels.map((p) =>
						p.id === panel.id ? { ...p, selected: e.currentTarget.value } : p,
					);
				}}
			>
				{#each viewOptions as option}
					<option value={option} disabled={option === "Select a view"}>{option}</option>
				{/each}
			</select>

			<div class="mt-2 flex-1 min-h-0 overflow-y-auto">
				{#if panel.selected === "Current Model"}
					<ModelSelector
						{keys}
						{activeKeyId}
						{activeModelId}
						{reasoningEffort}
						{onKeyChange}
						{onModelChange}
						{onReasoningChange}
					/>
				{:else if panel.selected === "Key Usage"}
					<KeyUsage {keys} {apiBase} />
				{:else if panel.selected === "Claude Reset"}
					<ClaudeReset {apiBase} />
				{:else if panel.selected === "Model Status"}
					<ModelStatus {models} {keys} {tags} />
				{:else if panel.selected === "Tasks"}
					<TaskListPanel {tasks} />
				{:else if panel.selected === "Config"}
					<ConfigPanel {apiBase} />
				{:else if panel.selected === "Skills"}
					<SkillsBrowser {apiBase} />
				{:else if panel.selected === "Permission Log"}
					<PermissionLog entries={permissionLog} />
				{/if}
			</div>
		</div>
	{/each}

	<button type="button" class="btn btn-sm btn-ghost w-full" onclick={addPanel}>
		+
	</button>
</div>
