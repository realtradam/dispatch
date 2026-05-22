<script module>
// Session-level cache for models per key; avoids refetching across component instances
const modelCache = new Map();
</script>

<script lang="ts">
	import { config } from "../config.js";
	import { router } from "../router.svelte.js";
	import type { KeyInfo } from "../types.js";
	import SkillsBrowser from "./SkillsBrowser.svelte";
	import ToolPermissions from "./ToolPermissions.svelte";

	interface AgentModelEntry {
		key_id: string;
		model_id: string;
	}

	interface AgentDefinition {
		name: string;
		description: string;
		skills: string[];
		tools: string[];
		models: AgentModelEntry[];
		scope: string;
		slug: string;
		cwd?: string;
		is_subagent?: boolean;
	}

	interface DirEntry {
		label: string;
		path: string;
		scope: string;
	}

	const { keys = [] }: { keys?: KeyInfo[] } = $props();



	// Portal action (escape stacking context)
	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			},
		};
	}

	// State
	let agents = $state<AgentDefinition[]>([]);
	let dirs = $state<DirEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);

	// Editor state
	let editing = $state(false);
	let editingSlug = $state<string | null>(null); // null = new agent

	let formName = $state("");
	let formDescription = $state("");
	let formScope = $state("global");
	let formCwd = $state("");
	let cwdExists = $state<boolean | null>(null);
	let cwdResolved = $state<string | null>(null);
	let cwdCheckTimer: ReturnType<typeof setTimeout> | null = null;
	let formSkills = $state<Set<string>>(new Set());
	let formTools = $state<Set<string>>(new Set());
	let formModels = $state<AgentModelEntry[]>([]);
	let formIsSubagent = $state(false);

	// Model selection modal state
	let modelModalIndex = $state<number | null>(null);
	let modelModalType = $state<"key" | "model">("key");
	let modalAvailableModels = $state<string[]>([]);
	let modalLoadingModels = $state(false);
	let modalModelError = $state<string | null>(null);

	// Drag-and-drop reorder state
	let dragIndex = $state<number | null>(null);
	let dragOverIndex = $state<number | null>(null);

	// Delete confirm
	let deletingAgent = $state<AgentDefinition | null>(null);

	function slugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			|| "agent";
	}

	async function fetchAgents() {
		loading = true;
		error = null;
		try {
			const res = await fetch(`${config.apiBase}/agents`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			agents = data.agents ?? [];
			dirs = data.dirs ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to fetch agents";
		} finally {
			loading = false;
		}
	}

	function handleSkillToggle(key: string, checked: boolean) {
		const next = new Set(formSkills);
		if (checked) next.add(key);
		else next.delete(key);
		formSkills = next;
	}

	function startNewAgent() {
		formReady = false;
		editingSlug = null;
		formName = "";
		formDescription = "";
		formScope = dirs[0]?.scope ?? "global";
		formCwd = "";
		formSkills = new Set();
		formTools = new Set();
		formModels = [];
		formIsSubagent = false;
		editing = true;
		// Allow the effect to skip the initial population
		setTimeout(() => { formReady = true; }, 0);
	}

	function startEdit(agent: AgentDefinition) {
		formReady = false;
		editingSlug = agent.slug;
		formName = agent.name;
		formDescription = agent.description;
		formScope = agent.scope;
		formCwd = agent.cwd ?? "";
		formSkills = new Set(agent.skills);
		formTools = new Set(agent.tools);
		formModels = agent.models.map((m) => ({ ...m }));
		formIsSubagent = agent.is_subagent ?? false;
		editing = true;
		// Allow the effect to skip the initial population
		setTimeout(() => { formReady = true; }, 0);
	}

	function cancelEdit() {
		// Flush any pending debounced save before leaving
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
			saveAgent();
		}
		formReady = false;
		editing = false;
		editingSlug = null;
	}

	function handleToolToggle(id: string, checked: boolean) {
		const next = new Set(formTools);
		if (checked) next.add(id);
		else next.delete(id);
		formTools = next;
	}

	function addModelEntry() {
		formModels = [...formModels, { key_id: "", model_id: "" }];
	}

	function removeModelEntry(i: number) {
		formModels = formModels.filter((_, idx) => idx !== i);
	}

	async function openKeyModal(i: number) {
		modelModalIndex = i;
		modelModalType = "key";
	}

	async function openModelModal(i: number) {
		const entry = formModels[i];
		if (!entry || !entry.key_id) return;
		modelModalIndex = i;
		modelModalType = "model";
		modalModelError = null;
		modalAvailableModels = [];

		if (modelCache.has(entry.key_id)) {
			modalAvailableModels = modelCache.get(entry.key_id)!;
			return;
		}

		modalLoadingModels = true;
		try {
			const res = await fetch(
				`${config.apiBase}/models/available?keyId=${encodeURIComponent(entry.key_id)}`,
			);
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				modalModelError = d.error ?? `HTTP ${res.status}`;
				return;
			}
			const d = await res.json();
			modalAvailableModels = d.models ?? [];
			modelCache.set(entry.key_id, modalAvailableModels);
		} catch (e) {
			modalModelError = e instanceof Error ? e.message : "Failed";
		} finally {
			modalLoadingModels = false;
		}
	}

	function selectKey(keyId: string) {
		if (modelModalIndex === null) return;
		const idx = modelModalIndex;
		formModels = formModels.map((m, i) =>
			i === idx ? { key_id: keyId, model_id: "" } : m,
		);
		modelModalIndex = null;
		// Immediately open model selection for the same row
		openModelModal(idx);
	}

	function selectModel(model: string) {
		if (modelModalIndex === null) return;
		formModels = formModels.map((m, i) =>
			i === modelModalIndex ? { ...m, model_id: model } : m,
		);
		modelModalIndex = null;
	}

	function closeModal() {
		modelModalIndex = null;
	}

	let formError = $state<string | null>(null);
	let saving = $state(false);
	let formReady = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let saveAbort: AbortController | null = null;

	function isFormValid(): boolean {
		if (!formName.trim()) return false;
		if (formModels.length === 0) return false;
		if (formModels.some((m) => !m.key_id || !m.model_id)) return false;
		return true;
	}

	async function saveAgent() {
		if (!isFormValid()) return;
		formError = null;

		// Cancel any in-flight save
		saveAbort?.abort();
		const controller = new AbortController();
		saveAbort = controller;

		const payload: AgentDefinition = {
			name: formName.trim(),
			description: formDescription.trim(),
			skills: Array.from(formSkills),
			tools: Array.from(formTools),
			models: formModels,
			scope: formScope,
			slug: editingSlug ?? slugify(formName.trim()),
			...(formCwd.trim() ? { cwd: formCwd.trim() } : {}),
			...(formIsSubagent ? { is_subagent: true } : {}),
		};

		saving = true;
		try {
			const res = await fetch(`${config.apiBase}/agents`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				formError = d.error ?? `HTTP ${res.status}`;
				return;
			}
			// If this was a new agent, lock in the slug for future saves
			if (!editingSlug) {
				editingSlug = payload.slug;
			}
			await fetchAgents();
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			formError = e instanceof Error ? e.message : "Failed to save";
		} finally {
			if (saveAbort === controller) {
				saving = false;
				saveAbort = null;
			}
		}
	}

	// Check if CWD directory exists (debounced)
	$effect(() => {
		const cwd = formCwd;
		if (!cwd.trim()) {
			cwdExists = null;
			cwdResolved = null;
			return;
		}
		if (cwdCheckTimer) clearTimeout(cwdCheckTimer);
		cwdCheckTimer = setTimeout(async () => {
			try {
				const res = await fetch(
					`${config.apiBase}/agents/check-dir?path=${encodeURIComponent(cwd.trim())}`,
				);
				if (res.ok) {
					const data = await res.json();
					cwdExists = data.exists ?? false;
					cwdResolved = data.resolved ?? null;
				}
			} catch {
				cwdExists = null;
				cwdResolved = null;
			}
		}, 300);
	});

	// Auto-save with debounce whenever form fields change
	$effect(() => {
		// Read all reactive form fields to subscribe
		// noinspection: intentionally unused — reading these values subscribes the effect to them
		void [formName, formDescription, formScope, formCwd, formSkills, formTools, formModels, formIsSubagent];
		if (!formReady || !editing) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			saveAgent();
		}, 600);
	});

	async function deleteAgent(agent: AgentDefinition) {
		try {
			// Prevent auto-save from re-creating the deleted agent
			formReady = false;
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			saveAbort?.abort();

			const res = await fetch(
				`${config.apiBase}/agents/${encodeURIComponent(agent.slug)}?scope=${encodeURIComponent(agent.scope)}`,
				{ method: "DELETE" },
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			deletingAgent = null;
			editing = false;
			editingSlug = null;
			await fetchAgents();
		} catch (e) {
			error = e instanceof Error ? e.message : "Failed to delete";
		}
	}

	const hasName = $derived(formName.trim().length > 0);

	const globalAgents = $derived(agents.filter((a) => a.scope === "global"));
	const projectAgents = $derived(agents.filter((a) => a.scope !== "global"));

	// Fetch on mount
	$effect(() => {
		fetchAgents();
	});
</script>

<div class="flex flex-col flex-1 overflow-hidden">
	<!-- Page header -->
	<div class="flex items-center gap-4 px-6 py-4 border-b border-base-300 bg-base-200 shrink-0">
		<h1 class="text-xl font-bold flex-1">Agent Settings</h1>
		<button
			type="button"
			class="btn btn-ghost btn-sm"
			onclick={() => { if (editing) { cancelEdit(); } else { router.navigate("dashboard"); } }}
		>
			{editing ? '← Back to Agent Settings' : '← Back to Dashboard'}
		</button>
	</div>

	<div class="flex-1 overflow-y-auto px-6 py-6">
		{#if error}
			<div class="alert alert-error mb-4">{error}</div>
		{/if}

		{#if editing}
			<!-- Agent Editor Form -->
			<div class="card bg-base-200 shadow-md">
				<div class="card-body gap-4">
					<h2 class="card-title">{editingSlug ? "Edit Agent" : "New Agent"}</h2>

					{#if formError}
						<div class="alert alert-error text-sm">{formError}</div>
					{/if}

					<!-- Name -->
					<div class="form-control gap-1">
						<label class="label py-0" for="agent-name">
							<span class="label-text font-semibold">Name *</span>
						</label>
						<input
							id="agent-name"
							type="text"
							class="input input-bordered"
							placeholder="my-agent"
							bind:value={formName}
						/>
						{#if formName}
							<span class="text-xs text-base-content/50">slug: {slugify(formName)}</span>
						{/if}
					</div>

					<fieldset disabled={!hasName} class="contents">
					<!-- Description -->
					<div class="form-control gap-1">
						<label class="label py-0" for="agent-desc">
							<span class="label-text font-semibold">Description</span>
						</label>
						<input
							id="agent-desc"
							type="text"
							class="input input-bordered"
							placeholder="What does this agent do?"
							bind:value={formDescription}
						/>
					</div>

					<!-- Is Subagent -->
					<div class="form-control">
						<label class="label cursor-pointer justify-start gap-3 py-1">
							<input
								type="checkbox"
								class="checkbox checkbox-sm rounded-sm"
								bind:checked={formIsSubagent}
							/>
							<div>
								<span class="label-text font-semibold">Is Subagent</span>
								<p class="text-xs text-base-content/50">Subagents are hidden from Chat Settings and can only be used by other agents.</p>
							</div>
						</label>
					</div>

					<!-- Scope -->
					<div class="form-control gap-1">
						<label class="label py-0" for="agent-scope">
							<span class="label-text font-semibold">Scope</span>
						</label>
						<select id="agent-scope" class="select select-bordered" bind:value={formScope}>
							<option value="global">Global</option>
							{#each dirs.filter((d) => d.scope !== "global") as dir}
								<option value={dir.scope}>{dir.label} ({dir.path})</option>
							{/each}
						</select>
					</div>

					<!-- Working Directory -->
					<div class="form-control gap-1">
						<label class="label py-0" for="agent-cwd">
							<span class="label-text font-semibold">Working Directory</span>
						</label>
						<div class="flex items-center gap-2">
							<input
								id="agent-cwd"
								type="text"
								class="input input-bordered font-mono text-sm flex-1"
								placeholder="default (project root)"
								bind:value={formCwd}
							/>
							{#if formCwd.trim()}
								{#if cwdExists === true}
									<span class="text-success text-lg" title="Directory exists">&#x2714;</span>
								{:else if cwdExists === false}
									<span class="text-warning text-lg" title="Directory does not exist (will be created)">&#x2716;</span>
								{:else}
									<span class="loading loading-spinner loading-xs"></span>
								{/if}
							{/if}
						</div>
						{#if cwdExists === false && formCwd.trim()}
							<span class="text-xs text-warning">Directory will be created automatically on first message.</span>
						{/if}
						{#if cwdResolved && formCwd.trim() && cwdResolved !== formCwd.trim()}
							<span class="text-xs text-base-content/50 font-mono">{cwdResolved}</span>
						{/if}
						{#if !formCwd.trim()}
							<span class="text-xs text-base-content/50">Absolute or relative path. Relative paths resolve against the parent agent's working directory, or the project root.</span>
						{/if}
					</div>

					<!-- Models -->
					<div class="form-control gap-2">
						<div class="label py-0">
							<span class="label-text font-semibold">Models *</span>
						</div>
					<div class="flex flex-col gap-2">
						{#each formModels as entry, i (i)}
							<div
								class="flex items-center gap-2 rounded p-1 transition-colors {dragOverIndex === i ? 'bg-primary/10 border border-primary/30' : ''}"
								draggable="true"
								role="listitem"
								ondragstart={(e) => {
									dragIndex = i;
									if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
								}}
								ondragover={(e) => {
									e.preventDefault();
									if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
									dragOverIndex = i;
								}}
								ondragleave={() => {
									if (dragOverIndex === i) dragOverIndex = null;
								}}
								ondrop={(e) => {
									e.preventDefault();
									if (dragIndex !== null && dragIndex !== i) {
										const reordered = [...formModels];
										const moved = reordered.splice(dragIndex, 1)[0];
										if (moved) {
											reordered.splice(i, 0, moved);
											formModels = reordered;
										}
									}
									dragIndex = null;
									dragOverIndex = null;
								}}
								ondragend={() => { dragIndex = null; dragOverIndex = null; }}
							>
								<span class="badge badge-sm badge-neutral font-mono w-6 shrink-0 cursor-grab">{i + 1}</span>
								<button
									type="button"
									class="btn btn-sm btn-outline flex-1 font-mono truncate"
									onclick={() => openKeyModal(i)}
								>
									{entry.key_id || "Select Key"}
								</button>
								<button
									type="button"
									class="btn btn-sm btn-outline flex-1 font-mono truncate"
									onclick={() => openModelModal(i)}
									disabled={!entry.key_id}
								>
									{entry.model_id || "Select Model"}
								</button>
								<button
									type="button"
									class="btn btn-sm btn-ghost text-error"
									onclick={() => removeModelEntry(i)}
									aria-label="Remove model entry"
								>
									✕
								</button>
							</div>
						{/each}
					</div>
						<button
							type="button"
							class="btn btn-sm btn-ghost w-fit"
							onclick={addModelEntry}
						>
							+ Add Model
						</button>
					</div>

					<!-- Tools -->
					<div class="form-control gap-2">
						<div class="label py-0">
							<span class="label-text font-semibold">Tools</span>
						</div>
						<ToolPermissions
							checkedTools={formTools}
							onToolToggle={handleToolToggle}
						/>
					</div>

					<!-- Skills -->
					<div class="form-control gap-2">
						<div class="label py-0">
							<span class="label-text font-semibold">Skills</span>
						</div>
						<SkillsBrowser
							apiBase={config.apiBase}
							checkedSkills={formSkills}
							onSkillToggle={handleSkillToggle}
						/>
					</div>

					<!-- Actions -->
					<div class="card-actions justify-between items-center pt-2">
						{#if editingSlug && !(editingSlug === "default" && formScope === "global")}
							<button
								type="button"
								class="btn btn-error btn-ghost"
								onclick={() => {
									const agent = agents.find((a) => a.slug === editingSlug && a.scope === formScope);
									if (agent) deletingAgent = agent;
								}}
							>Delete</button>
						{:else}
							<div></div>
						{/if}
						<div class="flex items-center gap-2">
							{#if saving}
								<span class="text-xs text-base-content/50">Saving...</span>
							{/if}
						</div>
					</div>
				</fieldset>
				</div>
			</div>
		{:else}
			<!-- Agent List -->
			{#if loading}
				<div class="flex justify-center py-16">
					<span class="loading loading-spinner loading-lg"></span>
				</div>
			{:else}
				<!-- Global Agents -->
				<section class="mb-8">
					<h2 class="text-lg font-semibold mb-3">Global Agents</h2>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{#each globalAgents as agent}
							<button
								type="button"
								class="card bg-base-200 shadow-sm hover:bg-base-300 transition-colors cursor-pointer text-left"
								onclick={() => startEdit(agent)}
							>
								<div class="card-body p-4 gap-2">
									<h3 class="font-semibold font-mono truncate">{agent.name}</h3>
									{#if agent.description}
										<p class="text-sm text-base-content/60 truncate">{agent.description}</p>
									{/if}
									<div class="flex gap-2 flex-wrap">
										<span class="badge badge-sm badge-neutral">{agent.models.length} model{agent.models.length !== 1 ? "s" : ""}</span>
										<span class="badge badge-sm badge-neutral">{agent.skills.length} skill{agent.skills.length !== 1 ? "s" : ""}</span>
										<span class="badge badge-sm badge-outline">{agent.tools.length} tool{agent.tools.length !== 1 ? "s" : ""}</span>
									</div>
								</div>
							</button>
						{/each}
						<button
							type="button"
							class="card bg-base-200 shadow-sm hover:bg-base-300 transition-colors cursor-pointer border-2 border-dashed border-base-content/20"
							onclick={startNewAgent}
						>
							<div class="card-body p-4 items-center justify-center">
								<span class="text-2xl text-base-content/30">+</span>
								<span class="text-sm text-base-content/50">New Agent</span>
							</div>
						</button>
					</div>
				</section>

				<!-- Project Agents -->
				{#if projectAgents.length > 0 || dirs.some((d) => d.scope !== "global")}
					<section>
						<h2 class="text-lg font-semibold mb-3">Project Agents</h2>
						{#if projectAgents.length === 0}
							<p class="text-base-content/50 italic text-sm">No project agents yet.</p>
						{:else}
							<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{#each projectAgents as agent}
									<button
										type="button"
										class="card bg-base-200 shadow-sm hover:bg-base-300 transition-colors cursor-pointer text-left"
										onclick={() => startEdit(agent)}
									>
										<div class="card-body p-4 gap-2">
											<h3 class="font-semibold font-mono truncate">{agent.name}</h3>
											{#if agent.description}
												<p class="text-sm text-base-content/60 truncate">{agent.description}</p>
											{/if}
											<p class="text-xs text-base-content/40 font-mono truncate">{agent.scope}</p>
											<div class="flex gap-2 flex-wrap">
												<span class="badge badge-sm badge-neutral">{agent.models.length} model{agent.models.length !== 1 ? "s" : ""}</span>
												<span class="badge badge-sm badge-neutral">{agent.skills.length} skill{agent.skills.length !== 1 ? "s" : ""}</span>
												<span class="badge badge-sm badge-outline">{agent.tools.length} tool{agent.tools.length !== 1 ? "s" : ""}</span>
											</div>
										</div>
									</button>
								{/each}
							</div>
						{/if}
					</section>
				{/if}
			{/if}
		{/if}
	</div>
</div>

<!-- Key selection modal -->
{#if modelModalIndex !== null && modelModalType === "key"}
	<div class="modal modal-open" use:portal>
		<div class="modal-box">
			<h3 class="font-bold text-xl">Select Key</h3>
			<div class="mt-4 flex flex-col gap-2">
				{#each keys as key}
					<button
						type="button"
						class="btn {formModels[modelModalIndex ?? 0]?.key_id === key.id ? 'btn-primary' : 'btn-ghost'} justify-start text-base"
						onclick={() => selectKey(key.id)}
					>
						<span class="font-mono">{key.id}</span>
						<span class="badge ml-auto">{key.provider}</span>
						<span class="badge {key.status === 'active' ? 'badge-success' : 'badge-error'}">{key.status}</span>
					</button>
				{/each}
			</div>
			<div class="modal-action">
				<button type="button" class="btn" onclick={closeModal}>Cancel</button>
			</div>
		</div>
		<button type="button" class="modal-backdrop" onclick={closeModal} aria-label="Close modal"></button>
	</div>
{/if}

<!-- Model selection modal -->
{#if modelModalIndex !== null && modelModalType === "model"}
	<div class="modal modal-open" use:portal>
		<div class="modal-box">
			<h3 class="font-bold text-xl">Select Model</h3>
			{#if modalLoadingModels}
				<div class="flex justify-center py-8">
					<span class="loading loading-spinner loading-lg"></span>
				</div>
			{:else if modalModelError}
				<div class="alert alert-error mt-4 text-base">
					<span>{modalModelError}</span>
				</div>
			{:else}
				<div class="mt-4 flex flex-col gap-1 max-h-96 overflow-y-auto">
					{#each modalAvailableModels as model}
						<button
							type="button"
							class="btn {formModels[modelModalIndex ?? 0]?.model_id === model ? 'btn-primary' : 'btn-ghost'} justify-start font-mono text-base"
							onclick={() => selectModel(model)}
						>
							{model}
						</button>
					{/each}
				</div>
			{/if}
			<div class="modal-action">
				<button type="button" class="btn" onclick={closeModal}>Cancel</button>
			</div>
		</div>
		<button type="button" class="modal-backdrop" onclick={closeModal} aria-label="Close modal"></button>
	</div>
{/if}

<!-- Delete confirm modal -->
{#if deletingAgent !== null}
	{@const agentToDelete = deletingAgent}
	<div class="modal modal-open" use:portal>
		<div class="modal-box">
			<h3 class="font-bold text-lg">Delete Agent</h3>
			<p class="py-4">
				Are you sure you want to delete <span class="font-mono font-semibold">{agentToDelete.name}</span>? This cannot be undone.
			</p>
			<div class="modal-action">
				<button type="button" class="btn btn-ghost" onclick={() => { deletingAgent = null; }}>Cancel</button>
				<button
					type="button"
					class="btn btn-error"
					onclick={() => deleteAgent(agentToDelete)}
				>Delete</button>
			</div>
		</div>
		<button type="button" class="modal-backdrop" onclick={() => { deletingAgent = null; }} aria-label="Close modal"></button>
	</div>
{/if}
