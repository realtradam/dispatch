<script lang="ts">
interface TaskItem {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "done";
}

const { tasks }: { tasks: TaskItem[] } = $props();

const doneCount = $derived(tasks.filter((t) => t.status === "done").length);
const inProgressCount = $derived(tasks.filter((t) => t.status === "in_progress").length);

function checkboxClass(status: TaskItem["status"]): string {
	switch (status) {
		case "pending":
			return "checkbox checkbox-sm rounded-sm checkbox-secondary";
		case "in_progress":
			return "checkbox checkbox-sm rounded-sm checkbox-info";
		case "done":
			return "checkbox checkbox-sm rounded-sm checkbox-success";
	}
}

function isChecked(status: TaskItem["status"]): boolean {
	return status === "done";
}

function isIndeterminate(status: TaskItem["status"]): boolean {
	return status === "in_progress";
}
</script>

<div class="flex flex-col gap-2">
	{#if tasks.length === 0}
		<p class="text-xs text-base-content/50">No tasks yet.</p>
	{:else}
		<p class="text-xs text-base-content/60">
			{doneCount}/{tasks.length} done{#if inProgressCount > 0}, {inProgressCount} in progress{/if}
		</p>
		<ul class="flex flex-col gap-0.5">
			{#each tasks as task (task.id)}
				<li
					class="flex items-start gap-2 rounded p-1.5 transition-colors {task.status === 'done' ? 'opacity-60' : ''}"
				>
					<input
						type="checkbox"
						class={checkboxClass(task.status)}
						checked={isChecked(task.status)}
						indeterminate={isIndeterminate(task.status)}
						disabled
						tabindex="-1"
					/>
					<div class="flex flex-col gap-0.5 min-w-0">
						<span
							class="text-xs leading-tight {task.status === 'done'
								? 'line-through text-base-content/50'
								: task.status === 'in_progress'
									? 'font-semibold'
									: ''}"
						>
							{task.title}
						</span>
						{#if task.description}
							<p class="text-xs text-base-content/50 line-clamp-2">{task.description}</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>
