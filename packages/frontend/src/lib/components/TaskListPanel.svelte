<script lang="ts">
import type { TaskItem } from "../types.js";

const { tasks }: { tasks: TaskItem[] } = $props();

type Status = TaskItem["status"];

const completedCount = $derived(tasks.filter((t) => t.status === "completed").length);
const inProgressCount = $derived(tasks.filter((t) => t.status === "in_progress").length);
const cancelledCount = $derived(tasks.filter((t) => t.status === "cancelled").length);
// "Active" total excludes cancelled items, so progress reads as work that still counts.
const activeTotal = $derived(tasks.length - cancelledCount);

function checkboxClass(status: Status): string {
	switch (status) {
		case "pending":
			return "checkbox checkbox-sm rounded-sm checkbox-secondary";
		case "in_progress":
			return "checkbox checkbox-sm rounded-sm checkbox-info";
		case "completed":
			return "checkbox checkbox-sm rounded-sm checkbox-success";
		case "cancelled":
			return "checkbox checkbox-sm rounded-sm checkbox-neutral";
	}
}

function isChecked(status: Status): boolean {
	return status === "completed";
}

function isIndeterminate(status: Status): boolean {
	return status === "in_progress";
}

function rowClass(status: Status): string {
	if (status === "completed") return "opacity-60";
	if (status === "cancelled") return "opacity-40";
	return "";
}

function textClass(status: Status): string {
	switch (status) {
		case "completed":
			return "line-through text-base-content/50";
		case "cancelled":
			return "line-through text-base-content/40";
		case "in_progress":
			return "font-semibold";
		default:
			return "";
	}
}
</script>

<div class="flex flex-col gap-2">
	{#if tasks.length === 0}
		<p class="text-xs text-base-content/50">No tasks yet.</p>
	{:else}
		<p class="text-xs text-base-content/60">
			{completedCount}/{activeTotal} completed{#if inProgressCount > 0}, {inProgressCount} in progress{/if}{#if cancelledCount > 0}, {cancelledCount} cancelled{/if}
		</p>
		<ul class="flex flex-col gap-0.5">
			{#each tasks as task (task.id)}
				<li class="flex items-start gap-2 rounded p-1.5 transition-colors {rowClass(task.status)}">
					<input
						type="checkbox"
						class={checkboxClass(task.status)}
						checked={isChecked(task.status)}
						indeterminate={isIndeterminate(task.status)}
						disabled
						tabindex="-1"
					/>
					<span class="text-xs leading-tight min-w-0 {textClass(task.status)}">
						{task.content}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
