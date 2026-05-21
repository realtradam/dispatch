<script lang="ts">
import { appSettings } from "../settings.svelte.js";
import { tabStore } from "../tabs.svelte.js";

interface Skill {
	name: string;
	description: string;
	tags: string[];
	scope: "global" | "project";
	directory: "default" | "agents" | "project";
}

interface SkillsResponse {
	skills: Skill[];
	mappings: unknown[];
}

interface SkillDetail extends Skill {
	content: string;
	source: string;
}

const { apiBase }: { apiBase: string } = $props();

let skills = $state<Skill[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);
let expandedSkill = $state<string | null>(null);
let expandedDetail = $state<SkillDetail | null>(null);
let loadingDetail = $state(false);

async function fetchSkills() {
	loading = true;
	error = null;
	try {
		const res = await fetch(`${apiBase}/skills`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data: SkillsResponse = await res.json();
		skills = data.skills ?? [];
	} catch (e) {
		error = e instanceof Error ? e.message : "Failed to fetch skills";
	} finally {
		loading = false;
	}
}

function skillKey(skill: Skill): string {
	return `${skill.scope}:${skill.name}`;
}

function isChecked(skill: Skill): boolean {
	return appSettings.skillChecks[skillKey(skill)] === true;
}

function isInjected(skill: Skill): boolean {
	return tabStore.activeTab?.injectedSkills.includes(skillKey(skill)) ?? false;
}

function toggleCheck(skill: Skill): void {
	const key = skillKey(skill);
	appSettings.skillChecks = { ...appSettings.skillChecks, [key]: !isChecked(skill) };
}

function resetChecks(): void {
	appSettings.skillChecks = {};
}

async function toggleExpand(skill: Skill) {
	const key = skillKey(skill);
	if (expandedSkill === key) {
		expandedSkill = null;
		expandedDetail = null;
		return;
	}
	expandedSkill = key;
	expandedDetail = null;
	loadingDetail = true;
	try {
		const res = await fetch(
			`${apiBase}/skills/${encodeURIComponent(skill.name)}?scope=${skill.scope}`,
		);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		expandedDetail = await res.json();
	} catch {
		expandedDetail = null;
	} finally {
		loadingDetail = false;
	}
}

$effect(() => {
	fetchSkills();
});

const checkedCount = $derived(Object.values(appSettings.skillChecks).filter((v) => v).length);
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center gap-2">
		<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Skills</div>
		{#if !loading}
			<span class="badge badge-sm badge-neutral">{skills.length}</span>
		{/if}
		{#if checkedCount > 0}
			<span class="badge badge-sm badge-primary">{checkedCount} queued</span>
		{/if}
		<button
			class="btn btn-xs btn-ghost ml-auto"
			onclick={fetchSkills}
			title="Refresh skills"
		>
			Refresh
		</button>
	</div>

	<p class="text-xs text-base-content/40">Check skills to inject with your next message.</p>

	{#if loading}
		<div class="flex items-center gap-2 py-2 text-base-content/60">
			<span class="loading loading-spinner loading-xs"></span>
			Loading skills...
		</div>
	{:else if error}
		<div class="alert alert-error text-xs py-2">{error}</div>
	{:else if skills.length === 0}
		<p class="text-base-content/50 italic py-2">
			No skills found. Create <code class="font-mono">.skills/</code> directories to get started.
		</p>
	{:else}
		<div class="flex flex-col gap-0.5">
			{#each skills as skill (skillKey(skill))}
				{@const key = skillKey(skill)}
				{@const checked = isChecked(skill)}
				{@const injected = isInjected(skill)}
				<div
					class="rounded p-1.5 transition-colors {injected ? 'bg-primary/10 border border-primary/20' : 'hover:bg-base-200'}"
				>
					<label class="flex items-start gap-2 cursor-pointer">
						<input
							type="checkbox"
							class="checkbox checkbox-sm checkbox-primary rounded-sm mt-0.5"
							checked={checked}
							onchange={() => toggleCheck(skill)}
						/>
						<div class="flex-1 min-w-0">
							<div class="flex items-center gap-1.5 flex-wrap">
								<button
									class="font-mono text-xs text-left hover:underline {injected ? 'text-primary font-semibold' : 'text-base-content'}"
									onclick={() => toggleExpand(skill)}
								>
									{skill.name}
								</button>
								<span class="badge badge-xs {skill.scope === 'global' ? 'badge-info' : 'badge-warning'}">{skill.scope}</span>
								{#if injected}
									<span class="badge badge-xs badge-primary">active</span>
								{/if}
								{#each skill.tags as tag}
									<span class="badge badge-xs badge-outline">{tag}</span>
								{/each}
							</div>
							{#if skill.description}
								<p class="text-xs text-base-content/50 truncate">{skill.description}</p>
							{/if}
						</div>
					</label>

					{#if expandedSkill === key}
						<div class="mt-2 ml-6 bg-base-300 rounded p-2">
							{#if loadingDetail}
								<span class="loading loading-spinner loading-xs text-base-content/40"></span>
							{:else if expandedDetail}
								<pre class="whitespace-pre-wrap font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto">{expandedDetail.content}</pre>
							{:else}
								<p class="text-error text-xs">Failed to load skill content.</p>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<button
		class="btn btn-sm btn-ghost w-full"
		disabled={!appSettings.skillChecksDirty}
		onclick={resetChecks}
	>
		Reset
	</button>
</div>
