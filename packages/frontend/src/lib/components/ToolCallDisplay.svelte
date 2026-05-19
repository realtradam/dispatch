<script lang="ts">
import type { ToolCallDisplay } from "../types.js";

const { toolCall }: { toolCall: ToolCallDisplay } = $props();

let isExpanded = $state(toolCall.isExpanded);

function toggle() {
	isExpanded = !isExpanded;
}
</script>

<div class="collapse collapse-arrow bg-base-200 my-1 rounded-lg border border-base-300 {isExpanded ? 'collapse-open' : ''}">
	<button
		type="button"
		class="collapse-title flex items-center gap-2 text-sm font-medium cursor-pointer w-full text-left"
		onclick={toggle}
		aria-expanded={isExpanded}
	>
		<span class="badge badge-neutral badge-sm">tool</span>
		<span class="font-mono">{toolCall.name}</span>
		{#if toolCall.result !== undefined}
			{#if toolCall.isError}
				<span class="badge badge-error badge-sm ml-auto">error</span>
			{:else}
				<span class="badge badge-success badge-sm ml-auto">done</span>
			{/if}
		{:else}
			<span class="badge badge-warning badge-sm ml-auto">pending</span>
		{/if}
	</button>

	{#if isExpanded}
		<div class="collapse-content text-xs">
			<div class="mt-2">
				<p class="font-semibold text-base-content/70 mb-1">Arguments</p>
				<pre class="bg-base-300 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{JSON.stringify(toolCall.arguments, null, 2)}</pre>
			</div>
			{#if toolCall.result !== undefined}
				<div class="mt-2">
					<p class="font-semibold text-base-content/70 mb-1">Result</p>
					<pre
						class="rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all {toolCall.isError
							? 'bg-error/20 text-error'
							: 'bg-base-300'}">{toolCall.result}</pre>
				</div>
			{/if}
		</div>
	{/if}
</div>
