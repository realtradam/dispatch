<script lang="ts">
interface Skill {
	name: string;
	description: string;
	tags: string[];
	scope: "global" | "project";
	directory: "default" | "agents" | "project";
}

interface SkillMapping {
	agentType: string;
	isOrchestrator: boolean;
	skills: string[];
	scope: string;
}

interface SkillsResponse {
	skills: Skill[];
	mappings: SkillMapping[];
}

interface SkillDetail extends Skill {
	content: string;
	source: string;
}

const { apiBase }: { apiBase: string } = $props();

let skills = $state<Skill[]>([]);
let mappings = $state<SkillMapping[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);
let expandedSkills = $state<Record<string, SkillDetail | null>>({});
let loadingSkill = $state<Record<string, boolean>>({});

async function fetchSkills() {
	loading = true;
	error = null;
	try {
		const res = await fetch(`${apiBase}/skills`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data: SkillsResponse = await res.json();
		skills = data.skills ?? [];
		mappings = data.mappings ?? [];
	} catch (e) {
		error = e instanceof Error ? e.message : "Failed to fetch skills";
	} finally {
		loading = false;
	}
}

async function toggleSkill(skill: Skill) {
	const key = `${skill.scope}:${skill.name}`;
	if (expandedSkills[key] !== undefined) {
		const updated = { ...expandedSkills };
		delete updated[key];
		expandedSkills = updated;
		return;
	}
	if (loadingSkill[key]) return;
	loadingSkill = { ...loadingSkill, [key]: true };
	try {
		const res = await fetch(`${apiBase}/skills/${encodeURIComponent(skill.name)}?scope=${skill.scope}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data: SkillDetail = await res.json();
		expandedSkills = { ...expandedSkills, [key]: data };
	} catch (_e) {
		expandedSkills = { ...expandedSkills, [key]: null };
	} finally {
		const updated = { ...loadingSkill };
		delete updated[key];
		loadingSkill = updated;
	}
}

$effect(() => {
	fetchSkills();
});

const globalSkills = $derived(skills.filter((s) => s.scope === "global"));
const projectSkills = $derived(skills.filter((s) => s.scope === "project"));

function skillsByDirectory(list: Skill[], dir: "default" | "agents" | "project") {
	return list.filter((s) => s.directory === dir);
}

function getMappingsForScope(scope: string) {
	return mappings.filter((m) => m.scope === scope);
}
</script>

<details class="collapse collapse-arrow bg-base-200 mt-4">
	<summary class="collapse-title text-sm font-medium flex items-center gap-2">
		<span>Skills</span>
		{#if !loading}
			<span class="badge badge-sm badge-neutral">{skills.length}</span>
		{/if}
		<button
			class="btn btn-xs btn-ghost ml-auto"
			onclick={(e) => { e.stopPropagation(); fetchSkills(); }}
			title="Refresh skills"
		>
			↺ Refresh
		</button>
	</summary>
	<div class="collapse-content text-xs">
		{#if loading}
			<div class="flex items-center gap-2 py-2 text-base-content/60">
				<span class="loading loading-spinner loading-xs"></span>
				Loading skills...
			</div>
		{:else if error}
			<div class="alert alert-error text-xs py-2">{error}</div>
		{:else if skills.length === 0}
			<p class="text-base-content/50 italic py-2">
				No skills found. Create a <code class="font-mono">.skills/default/</code> directory to get started.
			</p>
		{:else}
			{#snippet skillItem(skill: Skill)}
				{@const key = `${skill.scope}:${skill.name}`}
				{@const isExpanded = key in expandedSkills}
				{@const detail = expandedSkills[key]}
				{@const isLoading = loadingSkill[key]}
				<div class="border-b border-base-300 last:border-0 py-1">
					<div class="flex items-start gap-1 flex-wrap">
						<button
							class="font-mono text-primary hover:underline text-left"
							onclick={() => toggleSkill(skill)}
						>
							{skill.name}
						</button>
						{#if isLoading}
							<span class="loading loading-spinner loading-xs text-base-content/40"></span>
						{/if}
						{#each skill.tags as tag}
							<span class="badge badge-xs badge-outline">{tag}</span>
						{/each}
					</div>
					{#if skill.description}
						<p class="text-base-content/60 truncate max-w-xs">{skill.description}</p>
					{/if}
					{#if isExpanded}
						<div class="mt-2 bg-base-300 rounded p-2">
							{#if detail}
								<pre class="whitespace-pre-wrap font-mono text-xs overflow-x-auto max-h-60 overflow-y-auto">{detail.content}</pre>
							{:else}
								<p class="text-error text-xs">Failed to load skill content.</p>
							{/if}
							<button
								class="btn btn-xs btn-ghost mt-1"
								onclick={() => toggleSkill(skill)}
							>
								Close
							</button>
						</div>
					{/if}
				</div>
			{/snippet}

			{#snippet scopeSection(label: string, scopeSkills: Skill[], scope: string)}
				{#if scopeSkills.length > 0}
					{@const defaultSkills = skillsByDirectory(scopeSkills, "default")}
					{@const agentSkills = skillsByDirectory(scopeSkills, "agents")}
					{@const projectDirSkills = skillsByDirectory(scopeSkills, "project")}
					{@const scopeMappings = getMappingsForScope(scope)}
					<div class="mb-3">
						<div class="flex items-center gap-1 mb-1">
							<span class="font-semibold text-base-content/80">{label}</span>
							<span class="badge badge-xs {scope === 'global' ? 'badge-info' : 'badge-warning'}">{scope}</span>
						</div>

						{#if defaultSkills.length > 0}
							<div class="ml-2 mb-2">
								<div class="text-base-content/50 mb-1">default/</div>
								<div class="ml-2">
									{#each defaultSkills as skill}
										{@render skillItem(skill)}
									{/each}
								</div>
							</div>
						{/if}

						{#if agentSkills.length > 0 || scopeMappings.length > 0}
							<div class="ml-2 mb-2">
								<div class="text-base-content/50 mb-1">agents/</div>
								<div class="ml-2">
									{#if scopeMappings.length > 0}
										{#each scopeMappings as mapping}
											<div class="py-1 border-b border-base-300 last:border-0">
												<div class="flex items-center gap-1 flex-wrap">
													<span class="font-mono text-secondary">{mapping.agentType}</span>
													{#if mapping.isOrchestrator}
														<span class="badge badge-xs badge-accent">(orchestrator)</span>
													{/if}
													<span class="text-base-content/40">→</span>
													{#each mapping.skills as skillName}
														{@const mappedSkill = agentSkills.find((s) => s.name === skillName)}
														{#if mappedSkill}
															{@render skillItem(mappedSkill)}
														{:else}
															<span class="font-mono text-base-content/60">{skillName}</span>
														{/if}
													{/each}
												</div>
											</div>
										{/each}
									{:else}
										{#each agentSkills as skill}
											{@render skillItem(skill)}
										{/each}
									{/if}
								</div>
							</div>
						{/if}

						{#if projectDirSkills.length > 0}
							<div class="ml-2 mb-2">
								<div class="text-base-content/50 mb-1">project/</div>
								<div class="ml-2">
									{#each projectDirSkills as skill}
										{@render skillItem(skill)}
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}
			{/snippet}

			{@render scopeSection("Global", globalSkills, "global")}
			{@render scopeSection("Project", projectSkills, "project")}
		{/if}
	</div>
</details>
