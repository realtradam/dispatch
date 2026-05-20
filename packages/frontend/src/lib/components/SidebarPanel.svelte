<script lang="ts">
	import ModelStatus from "./ModelStatus.svelte";
	import TaskListPanel from "./TaskListPanel.svelte";
	import ConfigPanel from "./ConfigPanel.svelte";
	import SkillsBrowser from "./SkillsBrowser.svelte";
	import PermissionLog from "./PermissionLog.svelte";
	import type { TaskItem, LogEntry, KeyInfo, ModelInfo } from "../types.js";

	const {
		models = [],
		keys = [],
		tags = [],
		tasks = [],
		permissionLog = [],
		apiBase = "",
	}: {
		models?: ModelInfo[];
		keys?: KeyInfo[];
		tags?: string[];
		tasks?: TaskItem[];
		permissionLog?: LogEntry[];
		apiBase?: string;
	} = $props();

	let selected = $state("Tasks");

	const options = ["Model Status", "Tasks", "Config", "Skills", "Permission Log"];
</script>

<div class="bg-base-200 rounded-lg p-3">
	<select
		class="select select-bordered select-sm w-full"
		bind:value={selected}
	>
		{#each options as option}
			<option value={option}>{option}</option>
		{/each}
	</select>

	<div class="mt-2">
		{#if selected === "Model Status"}
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
