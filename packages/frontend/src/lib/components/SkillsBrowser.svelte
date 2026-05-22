<script lang="ts">
import { appSettings } from "../settings.svelte.js";
import { tabStore } from "../tabs.svelte.js";

interface Skill {
	name: string;
	description: string;
	tags: string[];
	scope: "global" | "project";
	directory: string;
}

interface SkillsResponse {
	skills: Skill[];
	mappings: unknown[];
}

interface SkillDetail extends Skill {
	content: string;
	source: string;
}

interface DirGroup {
	path: string;
	label: string;
	scope: "global" | "project";
	skills: Skill[];
}

const {
	apiBase,
	checkedSkills = null,
	onSkillToggle = null,
}: {
	apiBase: string;
	/** External checked set (agent builder mode). When null, uses appSettings. */
	checkedSkills?: Set<string> | null;
	/** Callback when a skill is toggled in external mode. */
	onSkillToggle?: ((key: string, checked: boolean) => void) | null;
} = $props();

/** Whether we're in external (agent builder) mode */
const externalMode = $derived(checkedSkills !== null && onSkillToggle !== null);

let skills = $state<Skill[]>([]);
let loading = $state(false);
let error = $state<string | null>(null);
let expandedSkill = $state<string | null>(null);
let expandedDetail = $state<SkillDetail | null>(null);
let loadingDetail = $state(false);
let collapsedDirs = $state<Set<string>>(new Set());

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

/** Build a unique key for a directory group (scope + path) */
function dirKey(group: DirGroup): string {
	return `${group.scope}:${group.path}`;
}

function isChecked(skill: Skill): boolean {
	const key = skillKey(skill);
	if (externalMode) {
		return checkedSkills?.has(key) ?? false;
	}
	return appSettings.skillChecks[key] === true;
}

function isInjected(skill: Skill): boolean {
	if (externalMode) return false;
	return tabStore.activeTab?.injectedSkills.includes(skillKey(skill)) ?? false;
}

function toggleCheck(skill: Skill): void {
	const key = skillKey(skill);
	if (externalMode) {
		onSkillToggle?.(key, !checkedSkills?.has(key));
		return;
	}
	appSettings.skillChecks = { ...appSettings.skillChecks, [key]: !isChecked(skill) };
}

function resetChecks(): void {
	if (externalMode) return;
	appSettings.skillChecks = {};
}

function toggleDir(key: string): void {
	const next = new Set(collapsedDirs);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	collapsedDirs = next;
}

/** Check if a group is hidden because an ancestor directory is collapsed */
function isHiddenByParent(group: DirGroup): boolean {
	if (!group.path.includes("/")) return false;
	// Check each ancestor path segment
	const parts = group.path.split("/");
	for (let i = 1; i < parts.length; i++) {
		const ancestorPath = parts.slice(0, i).join("/");
		const ancestorKey = `${group.scope}:${ancestorPath}`;
		if (collapsedDirs.has(ancestorKey)) return true;
	}
	return false;
}

/** Get the top-level directory for grouping spacing */
function topLevelDir(group: DirGroup): string {
	const slash = group.path.indexOf("/");
	return slash === -1 ? group.path : group.path.slice(0, slash);
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

const checkedCount = $derived(
	externalMode
		? (checkedSkills?.size ?? 0)
		: Object.values(appSettings.skillChecks).filter((v) => v).length,
);

/** Group skills by scope + directory, sorted */
const dirGroups = $derived.by((): DirGroup[] => {
	const map = new Map<string, DirGroup>();
	for (const skill of skills) {
		const key = `${skill.scope}:${skill.directory}`;
		let group = map.get(key);
		if (!group) {
			const label = skill.directory || "(root)";
			group = { path: skill.directory, label, scope: skill.scope, skills: [] };
			map.set(key, group);
		}
		group.skills.push(skill);
	}
	// Sort: global before project, then alphabetically by path
	const groups = Array.from(map.values());
	groups.sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
		return a.path.localeCompare(b.path);
	});
	// Sort skills within each group alphabetically
	for (const g of groups) {
		g.skills.sort((a, b) => a.name.localeCompare(b.name));
	}
	return groups;
});
</script>

<div class="flex flex-col gap-3">
	<div class="flex items-center gap-2">
		<div class="text-xs font-semibold text-base-content/50 uppercase tracking-wide">Skills</div>
		{#if !loading}
			<span class="badge badge-sm badge-neutral">{skills.length}</span>
		{/if}
		{#if checkedCount > 0}
			<span class="badge badge-sm badge-primary">{checkedCount} {externalMode ? 'selected' : 'queued'}</span>
		{/if}
		<button
			class="btn btn-xs btn-ghost ml-auto"
			onclick={fetchSkills}
			title="Refresh skills"
		>
			Refresh
		</button>
	</div>

	{#if !externalMode}
		<p class="text-xs text-base-content/40">Check skills to inject with your next message.</p>
	{/if}

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
		<div class="flex flex-col">
			{#each dirGroups as group, idx (dirKey(group))}
				{@const collapsed = collapsedDirs.has(dirKey(group))}
				{@const hidden = isHiddenByParent(group)}
				{@const prevGroup = dirGroups[idx - 1]}
				{@const isNewTopLevel = idx === 0 || !prevGroup || topLevelDir(group) !== topLevelDir(prevGroup) || group.scope !== prevGroup.scope}
				{#if !hidden}
					{#if isNewTopLevel && idx > 0}
						<div class="divider my-1"></div>
					{/if}
					<div class="{isNewTopLevel ? '' : 'mt-0.5'}">
						<div class="rounded border border-base-content/20">
							<!-- Directory header -->
							<button
								type="button"
								class="flex items-center gap-1.5 w-full px-2 py-1.5 text-left hover:bg-base-200 transition-colors rounded-t"
								onclick={() => toggleDir(dirKey(group))}
							>
								<span class="text-xs text-base-content/40 w-3 inline-block transition-transform {collapsed ? '-rotate-90' : ''}">▼</span>
								<span class="font-mono text-xs font-semibold text-base-content/70">{group.label}</span>
								<span class="badge badge-xs {group.scope === 'global' ? 'badge-info' : 'badge-warning'}">{group.scope}</span>
								<span class="badge badge-xs badge-neutral ml-auto">{group.skills.length}</span>
							</button>

							<!-- Skills in this directory -->
							{#if !collapsed}
								<div class="flex flex-col gap-0.5 px-1 pb-1">
									{#each group.skills as skill (skillKey(skill))}
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
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/if}

	{#if !externalMode}
		<button
			class="btn btn-sm btn-ghost w-full"
			disabled={!appSettings.skillChecksDirty}
			onclick={resetChecks}
		>
			Reset
		</button>
	{/if}
</div>
