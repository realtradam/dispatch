<script lang="ts">
import { loadSidebarPanels, saveSidebarPanels } from "../sidebar-storage.js";
import type { CacheStats, KeyInfo, LogEntry, TaskItem } from "../types.js";
import CacheRatePanel from "./CacheRatePanel.svelte";
import ClaudeReset from "./ClaudeReset.svelte";
import ConfigPanel from "./ConfigPanel.svelte";
import ContextWindowPanel from "./ContextWindowPanel.svelte";
import DebugPanel from "./DebugPanel.svelte";
import KeyUsage from "./KeyUsage.svelte";
import ModelSelector from "./ModelSelector.svelte";
import ModelStatus from "./ModelStatus.svelte";
import SettingsPanel from "./SettingsPanel.svelte";
import SkillsBrowser from "./SkillsBrowser.svelte";
import TaskListPanel from "./TaskListPanel.svelte";
import ToolPermissions from "./ToolPermissions.svelte";

interface AgentInfo {
	slug: string;
	scope: string;
	skills: string[];
	tools: string[];
	models: Array<{ key_id: string; model_id: string }>;
	cwd?: string;
}

const {
	keys = [],
	tasks = [],
	cacheStats = null,
	cacheTabTitle = null,
	contextLimit = null,
	permissionLog = [],
	apiBase = "",
	activeKeyId = null,
	activeModelId = null,
	reasoningEffort = "max",
	activeAgentSlug = null as string | null,
	activeTabParentId = null as string | null,
	activeAgentModels = null as Array<{ key_id: string; model_id: string; effort?: string }> | null,
	workingDirectory = null as string | null,
	onKeyChange,
	onModelChange,
	onReasoningChange,
	onAgentChange = (_agent: AgentInfo | null) => {},
	onWorkingDirectoryChange = (_dir: string | null) => {},
	onAddKey = () => {},
}: {
	keys?: KeyInfo[];
	tasks?: TaskItem[];
	cacheStats?: CacheStats | null;
	cacheTabTitle?: string | null;
	contextLimit?: number | null;
	permissionLog?: LogEntry[];
	apiBase?: string;
	activeKeyId?: string | null;
	activeModelId?: string | null;
	reasoningEffort?: string;
	activeAgentSlug?: string | null;
	activeTabParentId?: string | null;
	activeAgentModels?: Array<{ key_id: string; model_id: string; effort?: string }> | null;
	workingDirectory?: string | null;
	onKeyChange: (keyId: string) => void;
	onModelChange: (keyId: string, modelId: string) => void;
	onReasoningChange: (effort: string) => void;
	onAgentChange?: (agent: AgentInfo | null) => void;
	onWorkingDirectoryChange?: (dir: string | null) => void;
	onAddKey?: () => void;
} = $props();

interface Panel {
	id: number;
	selected: string;
}

// The `id` field is purely a stable key for Svelte's `{#each ... (panel.id)}`
// block within a single session — it is NEVER persisted. Only the ordered
// list of `selected` strings is round-tripped through localStorage; ids are
// regenerated fresh from `nextId` on every mount.
let nextId = 0;
let panels = $state<Panel[]>(loadSidebarPanels().map((selected) => ({ id: nextId++, selected })));

// Persist the layout whenever it changes. `$effect` re-runs whenever any
// reactive read inside it changes; we read `panels` (the whole array) via
// `.map`, which Svelte 5 tracks. Save errors are swallowed inside
// `saveSidebarPanels` — best-effort.
$effect(() => {
	saveSidebarPanels(panels.map((p) => p.selected));
});

const viewOptions = [
	"Select a view",
	"Chat Settings",
	"Key Usage",
	"Cache Rate",
	"Context Window",
	"Claude Reset",
	"Model Status",
	"Tasks",
	"Config",
	"Skills",
	"Tools",
	"Settings",
	"Debug",
];

function addPanel() {
	panels = [...panels, { id: nextId++, selected: "Select a view" }];
}

// Every panel sizes to its content; the sidebar itself (in App.svelte) is the
// scroll container. We deliberately do NOT use `flex-1` fill here: a filled
// panel combined with `min-h-0` lets flex shrink the panel below its content's
// natural height, and since the content wrapper is a plain block the inner
// scroll regions never receive a bounded height — so their bars/lists spill
// out of the panel into neighbours or past the window edge.
function panelClass(_selected: string): string {
	return "bg-base-200 rounded-lg p-3 flex flex-col";
}

function contentClass(_selected: string): string {
	return "mt-2";
}
</script>

<div class="flex flex-col gap-2 min-h-0">
	{#each panels as panel, idx (panel.id)}
		<div class={panelClass(panel.selected)}>
			<div class="flex items-center gap-1">
				<select
					class="select select-bordered select-sm flex-1"
					value={panel.selected}
					onchange={(e) => {
						panels = panels.map((p) =>
							p.id === panel.id ? { ...p, selected: e.currentTarget.value } : p,
						);
					}}
				>
					{#each viewOptions as option}
						<option value={option} disabled={option === "Select a view"}>{option}</option>
					{/each}
				</select>
				{#if idx > 0}
					<button
						type="button"
						class="btn btn-sm btn-ghost btn-square shrink-0"
						aria-label="Remove panel"
						onclick={() => {
							panels = panels.filter((p) => p.id !== panel.id);
						}}
					>
						✕
					</button>
				{/if}
			</div>

			<div class={contentClass(panel.selected)}>
				{#if panel.selected === "Chat Settings"}
			<ModelSelector
				{keys}
				{activeKeyId}
				{activeModelId}
				{reasoningEffort}
				{onKeyChange}
				{onModelChange}
				{onReasoningChange}
				{activeAgentSlug}
				{activeTabParentId}
				{activeAgentModels}
				{onAgentChange}
				{workingDirectory}
				{onWorkingDirectoryChange}
			/>
				{:else if panel.selected === "Key Usage"}
					<KeyUsage {keys} {apiBase} />
				{:else if panel.selected === "Cache Rate"}
					<CacheRatePanel {cacheStats} tabTitle={cacheTabTitle} />
				{:else if panel.selected === "Context Window"}
					<ContextWindowPanel
						{cacheStats}
						{contextLimit}
						tabTitle={cacheTabTitle}
						modelId={activeModelId}
					/>
				{:else if panel.selected === "Claude Reset"}
					<ClaudeReset {apiBase} />
				{:else if panel.selected === "Model Status"}
					<ModelStatus {keys} {apiBase} {onAddKey} />
				{:else if panel.selected === "Tasks"}
					<TaskListPanel {tasks} />
				{:else if panel.selected === "Config"}
					<ConfigPanel {apiBase} />
				{:else if panel.selected === "Skills"}
					<SkillsBrowser {apiBase} />
				{:else if panel.selected === "Tools"}
					<ToolPermissions entries={permissionLog} {apiBase} />
				{:else if panel.selected === "Settings"}
					<SettingsPanel {keys} {apiBase} />
				{:else if panel.selected === "Debug"}
					<DebugPanel />
				{/if}
			</div>
		</div>
	{/each}

	<button type="button" class="btn bg-base-200 hover:bg-base-300 border-none w-full text-lg" onclick={addPanel}>
		+
	</button>
</div>
