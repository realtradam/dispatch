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

	let selected = $state("Current Model");

	const options = ["Current Model", "Key Usage", "Claude Reset", "Model Status", "Tasks", "Config", "Skills", "Permission Log"];
</script>

<div class="bg-base-200 rounded-lg p-3 flex flex-col min-h-0">
	<select
		class="select select-bordered select-sm w-full"
		bind:value={selected}
	>
		{#each options as option}
			<option value={option}>{option}</option>
		{/each}
	</select>

	<div class="mt-2 flex-1 min-h-0">
		{#if selected === "Current Model"}
			<ModelSelector
				{keys}
				{activeKeyId}
				{activeModelId}
				{reasoningEffort}
				{onKeyChange}
				{onModelChange}
				{onReasoningChange}
			/>
		{:else if selected === "Key Usage"}
			<KeyUsage {keys} {apiBase} />
		{:else if selected === "Claude Reset"}
			<ClaudeReset {apiBase} />
		{:else if selected === "Model Status"}
			<ModelStatus {models} {keys} {tags} />
		{:else if selected === "Tasks"}
			<TaskListPanel {tasks} />
		{:else if selected === "Config"}
			<ConfigPanel {apiBase} />
		{:else if selected === "Skills"}
			<SkillsBrowser {apiBase} />
		{:else if selected === "Permission Log"}
			<PermissionLog entries={permissionLog} />
		{/if}
	</div>
</div>
