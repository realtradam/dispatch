<script lang="ts">
	interface TaskItem {
		id: string;
		title: string;
		description: string;
		status: "pending" | "in_progress" | "done" | "blocked";
	}

	const { tasks }: { tasks: TaskItem[] } = $props();

	const doneCount = $derived(tasks.filter((t) => t.status === "done").length);
	const inProgressCount = $derived(tasks.filter((t) => t.status === "in_progress").length);

	function badgeClass(status: TaskItem["status"]): string {
		switch (status) {
			case "pending":
				return "badge badge-ghost badge-xs";
			case "in_progress":
				return "badge badge-info badge-xs";
			case "done":
				return "badge badge-success badge-xs";
			case "blocked":
				return "badge badge-warning badge-xs";
		}
	}

	function statusIcon(status: TaskItem["status"]): string {
		switch (status) {
			case "pending":
				return "⏳";
			case "in_progress":
				return "▶";
			case "done":
				return "✓";
			case "blocked":
				return "⚠";
		}
	}
</script>

<div class="flex flex-col gap-2">
	{#if tasks.length === 0}
		<p class="text-xs text-base-content/50">No tasks yet.</p>
	{:else}
		<p class="text-xs text-base-content/60">
			{tasks.length} task{tasks.length !== 1 ? "s" : ""}
			({doneCount} done, {inProgressCount} in progress)
		</p>
		<ul class="flex flex-col gap-1">
			{#each tasks as task (task.id)}
				<li class="flex flex-col gap-0.5 rounded p-1.5 hover:bg-base-200 transition-colors">
					<div class="flex items-center gap-1.5">
						<span class={badgeClass(task.status)}>
							{statusIcon(task.status)}
						</span>
						<span
							class="text-sm leading-tight {task.status === 'in_progress'
								? 'font-bold'
								: 'font-medium'}"
						>
							{task.title}
						</span>
					</div>
					{#if task.description}
						<p class="text-xs text-base-content/60 line-clamp-2 pl-5">{task.description}</p>
					{/if}
					<p class="text-xs text-base-content/30 pl-5 font-mono">{task.id}</p>
				</li>
			{/each}
		</ul>
	{/if}
</div>
