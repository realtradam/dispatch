<script lang="ts">
import { tabStore } from "../tabs.svelte.js";
import type { ToolCallDisplay } from "../types.js";

const { toolCall }: { toolCall: ToolCallDisplay } = $props();

let isExpanded = $state(false);

function toggle() {
	isExpanded = !isExpanded;
}

interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function parseShellResult(result: string): ShellResult | null {
	try {
		const parsed = JSON.parse(result) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"stdout" in parsed &&
			"stderr" in parsed &&
			"exitCode" in parsed
		) {
			return {
				stdout: String((parsed as Record<string, unknown>).stdout ?? ""),
				stderr: String((parsed as Record<string, unknown>).stderr ?? ""),
				exitCode: Number((parsed as Record<string, unknown>).exitCode ?? 0),
			};
		}
		return null;
	} catch {
		return null;
	}
}

const isShell = $derived(toolCall.name === "run_shell");
const shellResult = $derived(
	isShell && toolCall.result !== undefined ? parseShellResult(toolCall.result) : null,
);

const summonAgentId = $derived.by(() => {
	if (toolCall.name !== "summon" || !toolCall.result) return null;
	const match = toolCall.result.match(/agent_id:\s*([a-f0-9-]+)/);
	return match ? match[1] : null;
});
</script>

<div class="collapse collapse-arrow mb-2 p-1 opacity-60 {isExpanded ? 'collapse-open' : ''}">
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="collapse-title flex items-center gap-2 text-sm italic cursor-pointer w-full text-left"
		onclick={toggle}
		role="button"
		tabindex="0"
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(); }}
		aria-expanded={isExpanded}
	>
		<span class="badge badge-neutral badge-sm">tool</span>
		<span class="font-mono">{toolCall.name}</span>
	{#if summonAgentId !== null}
		<button
			type="button"
			class="btn btn-xs btn-ghost"
			onclick={(e) => { e.stopPropagation(); tabStore.openAgentTab(summonAgentId!); }}
		>Open Tab</button>
	{/if}
		{#if toolCall.result !== undefined}
			{#if toolCall.result.includes("[USER INTERRUPT]")}
				<span class="badge badge-info badge-sm ml-auto">interrupted</span>
			{:else if isShell && shellResult !== null}
				<span class="badge badge-sm ml-auto {shellResult.exitCode === 0 ? 'badge-success' : 'badge-error'}">
					exit {shellResult.exitCode}
				</span>
			{:else if toolCall.isError}
				<span class="badge badge-error badge-sm ml-auto">error</span>
			{:else}
				<span class="badge badge-success badge-sm ml-auto">done</span>
			{/if}
		{:else}
			<span class="badge badge-warning badge-sm ml-auto">pending</span>
		{/if}
	</div>

	<div class="collapse-content text-xs">
		<div class="mt-2">
			<p class="font-semibold text-base-content/70 mb-1">Arguments</p>
			<pre class="bg-base-300 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all">{JSON.stringify(toolCall.arguments, null, 2)}</pre>
		</div>
		{#if isShell && toolCall.result !== undefined}
			{#if shellResult !== null}
				<div class="mt-2">
					<p class="font-semibold text-base-content/70 mb-1">stdout:</p>
					<pre class="bg-base-300 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all font-mono">{shellResult.stdout || "(empty)"}</pre>
				</div>
				{#if shellResult.stderr}
					<div class="mt-2">
						<p class="font-semibold text-error/80 mb-1">stderr:</p>
						<pre class="bg-error/10 text-error rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all font-mono">{shellResult.stderr}</pre>
					</div>
				{/if}
				<div class="mt-2 flex items-center gap-2">
					<span class="font-semibold text-base-content/70">exit code:</span>
					<span class="badge badge-sm {shellResult.exitCode === 0 ? 'badge-success' : 'badge-error'}">{shellResult.exitCode}</span>
				</div>
			{:else}
				<div class="mt-2">
					<p class="font-semibold text-base-content/70 mb-1">Result</p>
					<pre class="rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all {toolCall.isError ? 'bg-error/20 text-error' : 'bg-base-300'}">{toolCall.result}</pre>
				</div>
			{/if}
		{:else if isShell && toolCall.shellOutput}
			{#if toolCall.shellOutput.stdout}
				<div class="mt-2">
					<p class="font-semibold text-base-content/70 mb-1">stdout</p>
					<pre class="bg-base-300 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all text-xs">{toolCall.shellOutput.stdout}</pre>
				</div>
			{/if}
			{#if toolCall.shellOutput.stderr}
				<div class="mt-2">
					<p class="font-semibold text-error/70 mb-1">stderr</p>
					<pre class="bg-error/10 rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all text-xs text-error">{toolCall.shellOutput.stderr}</pre>
				</div>
			{/if}
			<span class="text-xs text-base-content/50 italic">Running...</span>
		{:else if toolCall.result !== undefined}
			<div class="mt-2">
				<p class="font-semibold text-base-content/70 mb-1">Result</p>
				<pre
					class="rounded p-2 overflow-auto max-h-40 whitespace-pre-wrap break-all {toolCall.isError
						? 'bg-error/20 text-error'
						: 'bg-base-300'}">{toolCall.result}</pre>
			</div>
		{/if}
	</div>
</div>
