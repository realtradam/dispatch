// Import the chunk-builder helpers directly from core so the frontend store
// and the backend agent share the exact same wire-format logic. Deep import
// is intentional: the core barrel pulls in node-only deps (chokidar, etc.)
// that don't belong in the browser bundle.
import {
	appendEventToChunks,
	applySystemEvent,
	type IdentifiedMessage,
	type SystemEventLike,
} from "@dispatch/core/src/chunks/append.js";
// DB-free; safe in the browser bundle. The flat chunk log is the frontend's
// source of truth for HISTORY; `groupRowsToMessages` derives render bubbles.
import { groupRowsToMessages, type MessageRow } from "@dispatch/core/src/chunks/transform.js";
import type { ChunkRow, UserContentPart } from "@dispatch/core/src/types/index.js";
import {
	type AgentModelEntry,
	DEFAULT_REASONING_EFFORT,
	isReasoningEffort,
	type ReasoningEffort,
} from "@dispatch/core/src/types/index.js";
import { intactTokenIds, type StagedAttachment } from "./attachment-tokens.js";
import { config } from "./config.js";
import { appSettings } from "./settings.svelte.js";
import type {
	AgentEvent,
	CacheStats,
	ChatMessage,
	Chunk,
	DebugInfo,
	LogEntry,
	PermissionPrompt,
	QueuedMessage,
	TabStatusSnapshot,
	TaskItem,
} from "./types.js";
import { wsClient } from "./ws.svelte.js";

function generateId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback for non-secure contexts (HTTP over Tailscale/LAN)
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
	});
}

function makeDebugInfo(overrides: Partial<DebugInfo> = {}): DebugInfo {
	return {
		timestamp: new Date().toISOString(),
		connectionStatus: wsClient.connectionStatus,
		...overrides,
	};
}

// ─── Chunk-log → render projection ───────────────────────────────
//
// History lives as a flat `ChunkRow[]` (sealed, real seq). For rendering we
// group it into bubbles with `groupRowsToMessages` (pairs tool_call+tool_result
// by callId, wraps a turn's assistant chunks) — a pure, ephemeral view, never
// stored as the source of truth.

/** Map a grouped chunk-row message to a render `ChatMessage`. */
function rowGroupToMessage(m: MessageRow): ChatMessage {
	return {
		id: m.id,
		role: m.role,
		chunks: m.chunks,
		isStreaming: false,
		seq: m.seq,
		turnId: m.turnId,
	};
}

/**
 * The render view for a tab: grouped sealed chunks followed by the transient
 * live tail (current unsealed turn). This is what the chat panel renders.
 */
function deriveRenderGroups(chunks: ChunkRow[], live: ChatMessage[]): ChatMessage[] {
	const sealed = groupRowsToMessages(chunks).map(rowGroupToMessage);
	return live.length > 0 ? [...sealed, ...live] : sealed;
}

/** Total chunk count of the live tail (for the eviction budget). */
function countLiveChunks(live: ChatMessage[]): number {
	return live.reduce((sum, m) => sum + m.chunks.length, 0);
}

/** Smallest `seq` among sealed chunk rows, or null when empty. */
function minSeqOf(chunks: ChunkRow[]): number | null {
	let min: number | null = null;
	for (const c of chunks) {
		if (typeof c.seq === "number" && (min === null || c.seq < min)) min = c.seq;
	}
	return min;
}

/** Merge older chunk rows into a window, dedupe by `seq`, keep ascending. */
function mergeChunksBySeq(existing: ChunkRow[], incoming: ChunkRow[]): ChunkRow[] {
	const bySeq = new Map<number, ChunkRow>();
	for (const c of existing) bySeq.set(c.seq, c);
	for (const c of incoming) bySeq.set(c.seq, c);
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Fetch a raw chunk window from the backend (the chunk-native load source). */
async function fetchChunkWindow(
	tabId: string,
	params: { limit?: number; before?: number } = {},
): Promise<{ ok: boolean; chunks: ChunkRow[]; total: number; oldestSeq: number | null }> {
	const qs = new URLSearchParams();
	if (params.limit !== undefined) qs.set("limit", String(params.limit));
	if (params.before !== undefined) qs.set("before", String(params.before));
	const q = qs.toString();
	try {
		const res = await fetch(`${config.apiBase}/tabs/${tabId}/chunks${q ? `?${q}` : ""}`);
		if (!res.ok) return { ok: false, chunks: [], total: 0, oldestSeq: null };
		const data = (await res.json()) as {
			chunks?: ChunkRow[];
			total?: number;
			oldestSeq?: number | null;
		};
		const chunks = Array.isArray(data.chunks) ? data.chunks : [];
		return {
			ok: true,
			chunks,
			total: data.total ?? chunks.length,
			oldestSeq: data.oldestSeq ?? minSeqOf(chunks),
		};
	} catch {
		return { ok: false, chunks: [], total: 0, oldestSeq: null };
	}
}

export interface Tab {
	id: string;
	title: string;
	/**
	 * SEALED conversation history as a flat chunk log (real per-tab `seq`).
	 * The source of truth for history and the unit of eviction + pagination.
	 */
	chunks: ChunkRow[];
	/**
	 * Transient render buffer for the CURRENT (unsealed) turn only: the
	 * optimistic user message, the in-flight assistant turn (folded from
	 * stream deltas), queued/consumed user messages, interrupt splits. Tiny and
	 * short-lived — cleared and folded into `chunks` (via refetch) the moment
	 * the turn seals. NOT stored history.
	 */
	live: ChatMessage[];
	/**
	 * Materialized render projection = groupRowsToMessages(chunks) ++ live,
	 * recomputed by `updateTab` after any change to `chunks`/`live`. A derived
	 * cache for the view layer — NOT the source of truth, never the
	 * eviction/pagination unit.
	 */
	renderGroups: ChatMessage[];
	/** turn_id of the in-flight turn (stable render keys + reconcile). */
	liveTurnId: string | null;
	agentStatus: "idle" | "running" | "error";
	keyId: string | null;
	modelId: string | null;
	reasoningEffort: ReasoningEffort;
	currentAssistantId: string | null;
	tasks: TaskItem[];
	injectedSkills: string[];
	parentTabId: string | null;
	persistent: boolean;
	agentSlug: string | null;
	agentScope: string | null;
	agentModels: AgentModelEntry[] | null;
	workingDirectory: string | null;
	queuedMessages: QueuedMessage[];
	chunkLimit: number;
	/** Smallest `seq` currently in `chunks` — the backward-pagination cursor. */
	oldestLoadedSeq: number | null;
	/** Total chunk count for this tab on the backend (drives "more to load?"). */
	totalChunks: number;
	/**
	 * Unsent chat-input text for THIS tab (in-memory only — never persisted).
	 * Saved/restored on tab switch so a draft is never lost or clobbered by
	 * switching tabs. Cleared on send.
	 */
	draft: string;
	/**
	 * Staged image/PDF attachments for THIS tab's unsent draft (in-memory only —
	 * never persisted). Each corresponds to an inline `【image:…】`/`【pdf:…】`
	 * token in `draft`; removing the token detaches the attachment (reconciled on
	 * every keystroke). Ephemeral: sent to the model for one turn, then cleared.
	 */
	attachments: StagedAttachment[];
	/**
	 * True once the user has manually renamed this tab (double-click rename).
	 * Suppresses the first-message auto-title so a chosen name is never
	 * clobbered. In-memory only — a renamed tab is no longer "New Tab" on
	 * reload, so the auto-title guard already won't fire for it.
	 */
	manualTitle: boolean;
	/**
	 * Cumulative prompt-cache token telemetry for this tab since the page
	 * loaded (in-memory only — resets on reload). Undefined until the first
	 * `usage` event arrives. Drives the "Cache Rate" sidebar view.
	 */
	cacheStats?: CacheStats;
}

/**
 * Build a fresh tab store. Exported so tests can construct a real
 * `$state`-backed instance per test — the production singleton is
 * exported below as `tabStore`. The previous test harness duplicated
 * the store logic against POJO arrays, which made the
 * `structuredClone(svelteProxy)` bug undetectable: native `structuredClone`
 * works on plain arrays and throws on Svelte reactive proxies. See the
 * `chat-store.test.ts` rewrite for the proper integration tests that
 * drive the actual reactive code path.
 */
export function createTabStore() {
	let tabs: Tab[] = $state([]);
	let activeTabId: string | null = $state(null);
	let pendingPermissions: PermissionPrompt[] = $state([]);
	let permissionLog: LogEntry[] = $state([]);
	let configReloaded = $state(false);
	let isConnected = $state(false);

	// Track message IDs that were consumed before the POST /chat response arrived.
	// Keyed by queueId — if consumed before we process the response, we skip the queued state.
	const recentlyConsumedIds = new Set<string>();

	// Tabs whose UI is currently scrolled up (viewing older history). While a
	// tab is in this set, automatic eviction is suppressed so messages don't
	// vanish out from under the user's viewport. ChatPanel toggles this via
	// `setScrolledUp`. A `force` eviction ignores this set entirely.
	const scrolledUpTabs = new Set<string>();

	// tabId → the turn_id whose reconcile was deferred because the user was
	// scrolled up. A Map (not a Set) so the deferred flush knows which turn
	// sealed and can preserve a newer turn that started streaming meanwhile.
	// Flushed when they return to the bottom so we don't yank their viewport.
	const pendingReconcileTabs = new Map<string, string>();

	// Clear any stale listeners from HMR reloads, then register
	wsClient.clearCallbacks();
	wsClient.onEvent((event) => {
		handleEvent(event as AgentEvent & { tabId?: string });
	});

	$effect.root(() => {
		$effect(() => {
			isConnected = wsClient.connectionStatus === "connected";
		});
	});

	function getActiveTab(): Tab | undefined {
		return tabs.find((t) => t.id === activeTabId);
	}

	function getTabById(id: string): Tab | undefined {
		return tabs.find((t) => t.id === id);
	}

	/**
	 * Minimum display length of a tab handle (git-style short id). Mirrors
	 * `MIN_TAB_PREFIX_LENGTH` in core's `db/tabs.ts` so the handle the user sees
	 * is always resolvable by the backend's `resolveTabPrefix`.
	 */
	const MIN_HANDLE_LENGTH = 4;

	/**
	 * Compute the shortest unique prefix (≥ MIN_HANDLE_LENGTH chars) of `tabId`
	 * among all currently-open tabs — the displayed "handle" agents use to
	 * address each other. Purely DERIVED from the UUIDs already in `tabs`; never
	 * stored. Grows by one char only when another open tab shares the prefix, and
	 * shrinks back when that sibling closes.
	 */
	function shortHandleFor(tabId: string): string {
		const others = tabs.map((t) => t.id).filter((id) => id !== tabId);
		for (let len = MIN_HANDLE_LENGTH; len < tabId.length; len++) {
			const candidate = tabId.slice(0, len);
			if (!others.some((id) => id.startsWith(candidate))) return candidate;
		}
		return tabId;
	}

	async function createNewTab(): Promise<Tab> {
		const id = generateId();
		const title = "New Tab";

		// Create on backend
		try {
			await fetch(`${config.apiBase}/tabs`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, title }),
			});
		} catch {
			// Continue even if backend fails — tab works locally
		}

		const tab: Tab = {
			id,
			title,
			chunks: [],
			live: [],
			renderGroups: [],
			liveTurnId: null,
			agentStatus: "idle",
			keyId: null,
			modelId: null,
			reasoningEffort: DEFAULT_REASONING_EFFORT,
			currentAssistantId: null,
			tasks: [],
			injectedSkills: [],
			parentTabId: null,
			persistent: true,
			agentSlug: null,
			agentScope: null,
			agentModels: null,
			workingDirectory: null,
			queuedMessages: [],
			chunkLimit: appSettings.chunkLimit,
			draft: "",
			attachments: [],
			manualTitle: false,
			oldestLoadedSeq: null,
			totalChunks: 0,
		};
		tabs = [...tabs, tab];
		activeTabId = id;

		// Auto-check default skills then apply default agent (sequential to avoid race)
		void (async () => {
			await autoCheckDefaultSkills();
			await autoSelectDefaultAgent(id);
		})();

		return tab;
	}

	function switchTab(id: string): void {
		if (tabs.some((t) => t.id === id)) {
			activeTabId = id;
		}
	}

	function promoteTab(id: string): void {
		const tab = getTabById(id);
		if (!tab) return;
		updateTab(id, { persistent: true });
		switchTab(id);
	}

	async function openAgentTab(agentId: string): Promise<void> {
		const tab = getTabById(agentId);
		if (tab) {
			updateTab(agentId, { persistent: true });
			switchTab(agentId);
			return;
		}

		// Tab not found locally — try to fetch from backend
		try {
			const tabRes = await fetch(`${config.apiBase}/tabs/${agentId}`);
			if (!tabRes.ok) return; // 404 or other error — tab doesn't exist
			const tabData = (await tabRes.json()) as {
				id: string;
				title: string;
				keyId?: string | null;
				modelId?: string | null;
				status?: string;
				parentTabId?: string | null;
			};

			// Load the tail of the flat chunk log (raw rows — the frontend groups
			// for render and evicts/paginates on the flat list).
			const win = await fetchChunkWindow(agentId, { limit: 100 });

			const newTab: Tab = {
				id: agentId,
				title: tabData.title,
				chunks: win.chunks,
				live: [],
				renderGroups: deriveRenderGroups(win.chunks, []),
				liveTurnId: null,
				agentStatus: "idle",
				keyId: tabData.keyId ?? null,
				modelId: tabData.modelId ?? null,
				reasoningEffort: DEFAULT_REASONING_EFFORT,
				currentAssistantId: null,
				tasks: [],
				injectedSkills: [],
				parentTabId: tabData.parentTabId ?? null,
				persistent: true,
				agentSlug: null,
				agentScope: null,
				agentModels: null,
				workingDirectory: null,
				queuedMessages: [],
				chunkLimit: appSettings.chunkLimit,
				draft: "",
				attachments: [],
				manualTitle: false,
				oldestLoadedSeq: win.oldestSeq,
				totalChunks: win.total,
			};
			tabs = [...tabs, newTab];
			activeTabId = agentId;
			evictChunks(agentId);
		} catch (err) {
			console.error("openAgentTab failed:", err);
		}
	}

	async function closeTab(id: string): Promise<void> {
		const tab = getTabById(id);
		if (!tab) return;

		// Archive on backend (also stops any running agent)
		try {
			await fetch(`${config.apiBase}/tabs/${id}`, { method: "DELETE" });
		} catch {
			// Continue with local removal
		}

		tabs = tabs.filter((t) => t.id !== id);

		// If we closed the active tab, switch to the last remaining or create a new one
		if (activeTabId === id) {
			if (tabs.length > 0) {
				const fallback = tabs[tabs.length - 1];
				if (fallback && !fallback.persistent) {
					updateTab(fallback.id, { persistent: true });
				}
				activeTabId = fallback?.id ?? null;
			} else {
				await createNewTab();
			}
		}
	}

	function updateTab(id: string, patch: Partial<Tab>): void {
		tabs = tabs.map((t) => {
			if (t.id !== id) return t;
			const next = { ...t, ...patch };
			// `renderGroups` is a derived cache: recompute it whenever its inputs
			// (`chunks` / `live`) change so the view layer never reads a stale
			// projection. Callers only ever mutate `chunks`/`live`.
			if ("chunks" in patch || "live" in patch) {
				next.renderGroups = deriveRenderGroups(next.chunks, next.live);
			}
			return next;
		});
	}

	/**
	 * Rename a tab. Records `manualTitle` so the first-message auto-title never
	 * clobbers the user's chosen name, and persists the new title to the DB
	 * (fire-and-forget — the optimistic local update is the source of truth for
	 * the open session).
	 */
	function renameTab(id: string, title: string): void {
		const trimmed = title.trim();
		if (!trimmed) return;
		updateTab(id, { title: trimmed, manualTitle: true });
		fetch(`${config.apiBase}/tabs/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: trimmed }),
		}).catch(() => {});
	}

	/**
	 * Reorder the top-row USER tabs to match `orderedUserTabIds`. Subagent tabs
	 * (those with a `parentTabId`) keep their relative order untouched — they
	 * live in a separate row and aren't draggable. The new left-to-right user
	 * order is persisted via `PATCH /tabs/reorder`, which rewrites each open
	 * tab's `position` (fire-and-forget, matching the title-persist style).
	 */
	function reorderTabs(orderedUserTabIds: string[]): void {
		const byId = new Map(tabs.map((t) => [t.id, t]));
		const ordered = orderedUserTabIds
			.map((id) => byId.get(id))
			.filter((t): t is Tab => t !== undefined && t.parentTabId === null);
		// Bail if the requested order doesn't cover exactly the current user tabs
		// (stale drag against a since-changed tab set) — never drop tabs.
		const currentUserCount = tabs.filter((t) => t.parentTabId === null).length;
		if (ordered.length !== currentUserCount) return;
		const subagentTabs = tabs.filter((t) => t.parentTabId !== null);
		tabs = [...ordered, ...subagentTabs];
		// Persist the full open-tab order (user tabs first, then subagents) so the
		// backend `position` column matches what the user sees on reload.
		const persistOrder = [...ordered, ...subagentTabs].map((t) => t.id);
		fetch(`${config.apiBase}/tabs/reorder`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ids: persistOrder }),
		}).catch(() => {});
	}

	/**
	 * Persist the unsent chat-input text for a tab (in-memory only). Saved on
	 * every keystroke so switching tabs preserves the draft and restoring the
	 * target tab shows its own text. No-op if the tab is gone.
	 */
	function setDraft(id: string, text: string): void {
		const tab = getTabById(id);
		if (!tab) return;
		// Detach any staged attachment whose inline token is no longer intact in
		// the new draft text (covers atomic-delete, manual mid-token edits, cut,
		// select-all-delete, etc.). The token in the textarea is the ONLY handle
		// on an attachment, so reconciling here keeps the two in lockstep.
		const intact = intactTokenIds(text);
		const keep = tab.attachments.filter((a) => intact.has(a.id));
		if (keep.length !== tab.attachments.length) {
			updateTab(id, { draft: text, attachments: keep });
		} else {
			updateTab(id, { draft: text });
		}
	}

	/**
	 * Stage a pasted attachment on a tab. The caller is responsible for also
	 * inserting the matching `【image:…】`/`【pdf:…】` token into the draft (the
	 * token is what keeps the attachment alive through reconciliation). No-op if
	 * the tab is gone.
	 */
	function addAttachment(id: string, attachment: StagedAttachment): void {
		const tab = getTabById(id);
		if (!tab) return;
		updateTab(id, { attachments: [...tab.attachments, attachment] });
	}

	/**
	 * Record whether a tab's chat view is scrolled up (viewing older history).
	 * Used to suppress automatic eviction while the user is reading old
	 * messages — we don't want to delete what they're currently looking at.
	 */
	function setScrolledUp(tabId: string, scrolledUp: boolean): void {
		if (scrolledUp) {
			scrolledUpTabs.add(tabId);
		} else {
			scrolledUpTabs.delete(tabId);
			// Returned to the bottom — run any reconcile we deferred while reading.
			const deferredTurnId = pendingReconcileTabs.get(tabId);
			if (deferredTurnId !== undefined) {
				pendingReconcileTabs.delete(tabId);
				reconcileSealedTurn(tabId, deferredTurnId);
			}
		}
	}

	/**
	 * Drop up to `n` of the oldest chunks from the live tail (front-to-back
	 * across its messages), never removing the chunk currently being streamed
	 * (the last chunk of the in-flight assistant message). Emptied messages are
	 * dropped. Used only when a single in-flight turn alone exceeds the budget.
	 */
	function trimLiveChunks(
		live: ChatMessage[],
		n: number,
		streamingId: string | null,
	): ChatMessage[] {
		let remaining = n;
		const out = live.map((m) => ({ ...m, chunks: [...m.chunks] }));
		for (const m of out) {
			if (remaining <= 0) break;
			const isStreamingMsg = m.id === streamingId || m.isStreaming === true;
			while (m.chunks.length > 0 && remaining > 0) {
				// Keep the last (open) chunk of the actively streaming message.
				if (isStreamingMsg && m.chunks.length === 1) break;
				m.chunks.shift();
				remaining--;
			}
		}
		return out.filter((m) => m.chunks.length > 0);
	}

	/**
	 * Bound a tab's in-memory footprint to `chunkLimit` by rolling eviction of
	 * the OLDEST chunks. Sealed history (`tab.chunks`) is trimmed from the front
	 * first; if a single in-flight turn alone still exceeds the budget, the
	 * oldest chunks of the live tail are trimmed too (never the chunk currently
	 * being streamed). Evicted sealed chunks are re-fetched on scroll-up via
	 * `loadOlderChunks`; live chunks that haven't sealed yet are recovered by
	 * the turn-completion reconcile once their write lands. Suppressed while
	 * scrolled up unless `force` is set.
	 */
	function evictChunks(tabId: string, force = false): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		if (!force && scrolledUpTabs.has(tabId)) return;

		const limit = appSettings.chunkLimit;
		if (!Number.isFinite(limit) || limit <= 0) return;

		let sealed = tab.chunks;
		let live = tab.live;
		let total = sealed.length + countLiveChunks(live);
		if (total <= limit) return;

		// 1. Drop oldest sealed chunk rows from the front.
		if (sealed.length > 0) {
			let dropTo = 0;
			while (total > limit && dropTo < sealed.length) {
				dropTo++;
				total--;
			}
			if (dropTo > 0) sealed = sealed.slice(dropTo);
		}

		// 2. Still over budget → one live turn exceeds the limit on its own.
		if (total > limit && live.length > 0) {
			live = trimLiveChunks(live, total - limit, tab.currentAssistantId);
		}

		updateTab(tabId, {
			chunks: sealed,
			live,
			oldestLoadedSeq: minSeqOf(sealed) ?? tab.oldestLoadedSeq,
		});
	}

	/**
	 * Fetch and prepend the next older page of CHUNKS (raw rows). Called when
	 * the user scrolls toward the top. Pages backward by the oldest loaded
	 * `seq` (`?before=`), dedupes by `seq`, and keeps the window seq-sorted —
	 * so a turn split across the window boundary regroups into one bubble with
	 * no special-casing. Does NOT evict (the user is reading history).
	 */
	async function loadOlderChunks(tabId: string): Promise<void> {
		const tab = getTabById(tabId);
		if (!tab) return;
		const before = tab.oldestLoadedSeq;
		const win = await fetchChunkWindow(tabId, {
			limit: 50,
			...(before !== null ? { before } : {}),
		});
		const current = getTabById(tabId);
		if (!current) return;
		if (win.chunks.length === 0) {
			// Nothing older; refresh the total if the backend reported a real one.
			if (win.total > 0) updateTab(tabId, { totalChunks: win.total });
			return;
		}
		const merged = mergeChunksBySeq(current.chunks, win.chunks);
		updateTab(tabId, {
			chunks: merged,
			oldestLoadedSeq: minSeqOf(merged),
			totalChunks: win.total,
		});
	}

	function ensureAssistantMessage(tabId: string): ChatMessage | null {
		const tab = getTabById(tabId);
		if (!tab) return null;

		if (tab.currentAssistantId) {
			const existing = tab.live.find((m) => m.id === tab.currentAssistantId);
			if (existing) return existing;
		}

		const id = generateId();
		const newMsg: ChatMessage = {
			id,
			role: "assistant",
			chunks: [],
			isStreaming: true,
			...(tab.liveTurnId !== null ? { turnId: tab.liveTurnId } : {}),
		};
		updateTab(tabId, {
			currentAssistantId: id,
			live: [...tab.live, newMsg],
		});
		evictChunks(tabId);
		return newMsg;
	}

	/**
	 * Update the live tail (the current unsealed turn). All streaming handlers
	 * operate here; sealed history (`tab.chunks`) is never touched by streaming.
	 */
	function updateLive(tabId: string, updater: (live: ChatMessage[]) => ChatMessage[]): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		updateTab(tabId, { live: updater(tab.live) });
	}

	/**
	 * Apply a content-producing event to the in-flight assistant message via the
	 * shared core helper.
	 *
	 * Reactivity contract: `appendEventToChunks` mutates the chunks array in
	 * place, but Svelte 5 `$state` only triggers updates when we reassign at the
	 * `tabs` array level. We snapshot the message's chunks via
	 * `$state.snapshot` (Svelte's own safe clone — strips reactive proxies and
	 * falls back gracefully where native `structuredClone` would throw
	 * `DataCloneError` on a `$state` proxy), mutate the snapshot, then write
	 * it back through `updateLive`. The previous use of `structuredClone`
	 * here threw silently and was swallowed by the WS try/catch — left chunks
	 * empty for every streaming turn.
	 */
	function applyChunkEvent(tabId: string, event: AgentEvent): void {
		ensureAssistantMessage(tabId);
		const tab = getTabById(tabId);
		if (!tab) return;
		const currentId = tab.currentAssistantId;
		if (!currentId) return;
		updateLive(tabId, (msgs) =>
			msgs.map((m) => {
				if (m.id !== currentId) return m;
				const cloned = $state.snapshot(m.chunks) as Chunk[];
				// The frontend's local AgentEvent is structurally compatible with
				// core's for every variant the helper cares about; the variants
				// where shapes differ (tab-created, done, status, message-*) are
				// all in the helper's no-op branch.
				appendEventToChunks(cloned, event as unknown as Parameters<typeof appendEventToChunks>[1]);
				return { ...m, chunks: cloned, isStreaming: true };
			}),
		);
		// A chunk may have just completed — keep the in-memory footprint bounded.
		evictChunks(tabId);
	}

	/**
	 * Route a system event when there's no in-flight assistant turn. Wraps
	 * `applySystemEvent` from core, which either appends a `system` chunk to
	 * the most recent `role: "system"` message or creates a new one.
	 */
	function routeSystemEvent(tabId: string, sysEvent: SystemEventLike): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		// Operate on the live tail (applySystemEvent appends a system chunk to
		// the trailing system message or creates one). Build a shallow-cloned
		// IdentifiedMessage[] view via `$state.snapshot` (safe against Svelte 5
		// reactive proxies; native `structuredClone` would throw), run the
		// helper, then write it back. The backend persists this system row too,
		// so it reconciles into `chunks` on the next turn/load.
		const view: IdentifiedMessage[] = tab.live.map((m) => ({
			id: m.id,
			role: m.role,
			chunks: $state.snapshot(m.chunks) as Chunk[],
		}));
		applySystemEvent(view, sysEvent, generateId);

		// Reconcile: rebuild the live array from the view, preserving existing
		// message metadata (isStreaming, debugInfo) where IDs match.
		const byId = new Map(tab.live.map((m) => [m.id, m]));
		const rebuilt: ChatMessage[] = view.map((v) => {
			const existing = byId.get(v.id);
			if (existing) {
				return { ...existing, role: v.role, chunks: v.chunks as Chunk[] };
			}
			return {
				id: v.id,
				role: v.role,
				chunks: v.chunks as Chunk[],
				isStreaming: false,
			};
		});
		updateTab(tabId, { live: rebuilt });
	}

	/**
	 * Reload a tab's chunk window from the API and fold the sealed turn out of
	 * the live tail. The persisted chunk log is the source of truth. Two modes:
	 *   - turn-completion reconcile (`preserveActiveTurn=true`, `sealedTurnId`
	 *     set): the just-sealed turn's rows now carry real seqs. Drop that turn
	 *     from `live`, but PRESERVE (a) a newer turn that began streaming while a
	 *     reconcile was deferred — the queued-message race — and (b) optimistic
	 *     user messages not yet bound to a turn, so neither is wiped.
	 *   - WS-reconnect desync (`preserveActiveTurn=false`): the backend has moved
	 *     on and is idle, so trust the DB fully and clear the live tail.
	 * A failed fetch is a no-op (never wipes a populated tab).
	 */
	async function reloadChunksFromApi(
		tabId: string,
		preserveActiveTurn = false,
		sealedTurnId?: string,
	): Promise<void> {
		const win = await fetchChunkWindow(tabId, { limit: 100 });
		if (!win.ok) return;
		const current = getTabById(tabId);
		if (!current) return;
		// A turn that started streaming AFTER the one being reconciled must not be
		// wiped — only the sealed turn folds into `chunks`.
		const preserveTurnId =
			preserveActiveTurn && current.liveTurnId !== null && current.liveTurnId !== sealedTurnId
				? current.liveTurnId
				: null;
		const keptLive = preserveActiveTurn
			? current.live.filter(
					(m) =>
						(preserveTurnId !== null && m.turnId === preserveTurnId) ||
						// Optimistic / queued user messages not yet bound to a turn.
						(m.turnId === undefined && m.role === "user"),
				)
			: [];
		const stillActive = preserveTurnId !== null;
		updateTab(tabId, {
			chunks: win.chunks,
			live: keptLive,
			liveTurnId: stillActive ? current.liveTurnId : null,
			currentAssistantId: stillActive ? current.currentAssistantId : null,
			oldestLoadedSeq: win.oldestSeq,
			totalChunks: win.total,
		});
		evictChunks(tabId);
	}

	/**
	 * Turn-completion reconcile. On `turn-sealed`, fold the just-finished turn
	 * (`sealedTurnId`) into the sealed log by reloading the chunk window (real
	 * seqs) and dropping that turn from the live tail — while preserving any
	 * newer in-flight turn and not-yet-sealed optimistic user messages. Deferred
	 * while the user is scrolled up so the viewport isn't disturbed; re-attempted
	 * (with the same `sealedTurnId`) when they return to the bottom.
	 */
	function reconcileSealedTurn(tabId: string, sealedTurnId: string): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		if (tab.live.length === 0 && tab.liveTurnId === null) return;
		if (scrolledUpTabs.has(tabId)) {
			pendingReconcileTabs.set(tabId, sealedTurnId);
			return;
		}
		pendingReconcileTabs.delete(tabId);
		void reloadChunksFromApi(tabId, true, sealedTurnId);
	}

	/**
	 * Hydrate the tab store from the backend on app mount. Restores the
	 * full list of open tabs (every row with `is_open = 1` in the DB),
	 * loads each tab's persisted message history, and seeds the in-flight
	 * assistant message for any tab the backend is currently streaming.
	 *
	 * Wire calls:
	 *   - GET /tabs                       → list of open tabs in `position` order
	 *   - GET /tabs/:id/messages          → persisted ChatMessage[] for each
	 *   - GET /status                     → in-flight TabStatusSnapshot map
	 *
	 * Failure modes (all log + continue with whatever was successfully
	 * hydrated; callers fall back to creating a fresh tab if the final
	 * `tabs` array is empty):
	 *   - /tabs request fails → no tabs restored
	 *   - /tabs/:id/messages fails → that tab restored with empty messages
	 *   - /status fails → tabs restored, in-flight streaming will be
	 *     lost (will surface as a static "running" status until the next
	 *     event arrives); harmless because the WS will broadcast `statuses`
	 *     on reconnect anyway.
	 *
	 * Returns the number of tabs hydrated (0 on total failure, ≥1 on
	 * partial or full success). Caller uses this to decide whether to
	 * create a fresh tab.
	 *
	 * Idempotency: if `tabs.length > 0` when called, returns 0 without
	 * touching state — the caller already has tabs from elsewhere (e.g.
	 * a hot-reload that preserved Svelte state).
	 */
	async function hydrateFromBackend(): Promise<number> {
		if (tabs.length > 0) return 0;

		// 1. Fetch the list of open tabs from the DB.
		let tabRows: Array<{
			id: string;
			title: string;
			keyId?: string | null;
			modelId?: string | null;
			parentTabId?: string | null;
			// Backend usage aggregate (GET /tabs). Structurally identical to
			// CacheStats, so it seeds `cacheStats` directly on reload. This is the
			// initial seed (hydrate runs only when tabs.length === 0, i.e. a true
			// reload); thereafter `turn-sealed` REPLACES cacheStats with the same
			// aggregate each turn, keeping the live accumulator reconciled to the DB
			// truth. Neither path ADDS to live events, so there is no double-count.
			usageStats?: CacheStats | null;
		}> = [];
		try {
			const res = await fetch(`${config.apiBase}/tabs`);
			if (!res.ok) return 0;
			const data = (await res.json()) as { tabs?: typeof tabRows };
			tabRows = Array.isArray(data.tabs) ? data.tabs : [];
		} catch {
			return 0;
		}

		if (tabRows.length === 0) return 0;

		// 2. Fetch the in-flight snapshot. Failure is non-fatal.
		let statusMap: Record<string, TabStatusSnapshot> = {};
		try {
			const res = await fetch(`${config.apiBase}/status`);
			if (res.ok) {
				const data = (await res.json()) as { statuses?: Record<string, TabStatusSnapshot> };
				if (data.statuses && typeof data.statuses === "object") {
					statusMap = data.statuses;
				}
			}
		} catch {
			// Non-fatal: tabs still restore with idle status.
		}

		// 3. For each tab, fetch its chunk window (raw rows) in parallel.
		type Win = { ok: boolean; chunks: ChunkRow[]; total: number; oldestSeq: number | null };
		const winByTab = new Map<string, Win>();
		for (const { id, win } of await Promise.all(
			tabRows.map(async (row) => ({
				id: row.id,
				win: await fetchChunkWindow(row.id, { limit: 100 }),
			})),
		)) {
			winByTab.set(id, win);
		}

		// 4. Build the Tab objects, seeding the in-flight live turn for running
		//    tabs from the status snapshot (the unsealed turn isn't in the DB
		//    yet; it reconciles into `chunks` when `turn-sealed` arrives).
		const restored: Tab[] = tabRows.map((row) => {
			const snap = statusMap[row.id];
			const win: Win = winByTab.get(row.id) ?? { ok: true, chunks: [], total: 0, oldestSeq: null };
			const agentStatus: Tab["agentStatus"] = snap?.status ?? "idle";

			let currentAssistantId: string | null = null;
			let liveTurnId: string | null = null;
			let live: ChatMessage[] = [];

			if (agentStatus === "running" && snap?.currentAssistantId) {
				currentAssistantId = snap.currentAssistantId;
				liveTurnId = snap.currentTurnId ?? null;
				live = [
					{
						id: snap.currentAssistantId,
						role: "assistant",
						chunks: snap.currentChunks ? [...snap.currentChunks] : [],
						isStreaming: true,
						...(liveTurnId !== null ? { turnId: liveTurnId } : {}),
					},
				];
			}

			return {
				id: row.id,
				title: row.title,
				chunks: win.chunks,
				live,
				renderGroups: deriveRenderGroups(win.chunks, live),
				liveTurnId,
				agentStatus,
				keyId: row.keyId ?? null,
				modelId: row.modelId ?? null,
				reasoningEffort: DEFAULT_REASONING_EFFORT,
				currentAssistantId,
				// Rehydrate the todo list from the backend snapshot so a reload
				// doesn't blank the Tasks panel mid-task.
				tasks: snap?.tasks ?? [],
				injectedSkills: [],
				parentTabId: row.parentTabId ?? null,
				persistent: true,
				agentSlug: null,
				agentScope: null,
				agentModels: null,
				workingDirectory: null,
				queuedMessages: [],
				chunkLimit: appSettings.chunkLimit,
				draft: "",
				attachments: [],
				manualTitle: false,
				oldestLoadedSeq: win.oldestSeq,
				totalChunks: win.total,
				cacheStats: row.usageStats ?? undefined,
			};
		});

		tabs = restored;
		// Trim each restored tab down to the chunk limit (user starts at bottom).
		for (const t of restored) {
			evictChunks(t.id);
		}
		// Activate the first restored tab (the list is already ordered by
		// `position` from the backend).
		activeTabId = restored[0]?.id ?? null;
		return restored.length;
	}

	function handleEvent(event: AgentEvent & { tabId?: string }): void {
		const tabId = event.tabId;

		switch (event.type) {
			case "status": {
				if (!tabId) break;
				updateTab(tabId, { agentStatus: event.status });
				if (event.status === "idle" || event.status === "error") {
					// Stop the streaming cursor immediately; the fold of the live
					// tail into the sealed chunk log happens on `turn-sealed`
					// (after the DB write lands — status fires before it).
					updateLive(tabId, (msgs) =>
						msgs.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m)),
					);
					updateTab(tabId, { currentAssistantId: null });
					const tab = getTabById(tabId);
					if (tab && !tab.persistent && tabId !== activeTabId) {
						tabs = tabs.filter((t) => t.id !== tabId);
					}
				}
				break;
			}
			case "turn-start": {
				if (!tabId) break;
				const tsTab = getTabById(tabId);
				// Tag the in-flight turn. Also backfill the turn_id onto THIS
				// turn's initiating optimistic user message — it was created on
				// send before the turn_id was known — so it key-matches the sealed
				// user row after reconcile (flicker-free; no remount).
				//
				// A turn-start corresponds to exactly one persisted user row
				// (processMessage → explodeUserText), and a queued message never
				// gets its own turn-start (it is drained into a running turn via
				// message-consumed). So the initiator is the single most-recent
				// NON-queued untagged user row. We must NOT tag pending `queued-`
				// rows: they belong to future turns, and tagging them here would
				// wipe them from the UI when THIS turn seals (reconcile drops live
				// rows bound to the sealed turn).
				const taggedLive = tsTab
					? (() => {
							const live = [...tsTab.live];
							for (let i = live.length - 1; i >= 0; i--) {
								const m = live[i];
								// Stop at the first non-user row (assistant/system
								// boundary): earlier user rows belong to prior turns.
								if (!m || m.role !== "user") break;
								// Skip past pending queued messages (future turns).
								if (m.id.startsWith("queued-")) continue;
								// Most-recent non-queued user row = this turn's
								// initiator. Tag it once (if untagged), then stop.
								if (m.turnId === undefined) {
									live[i] = { ...m, turnId: event.turnId };
								}
								break;
							}
							return live;
						})()
					: undefined;
				updateTab(tabId, {
					liveTurnId: event.turnId,
					...(taggedLive ? { live: taggedLive } : {}),
				});
				break;
			}
			case "turn-sealed": {
				if (!tabId) break;
				// The turn's rows are now durable — fold THIS turn out of the live
				// tail into the sealed chunk log (refetch real seqs), preserving any
				// newer in-flight turn. Deferred while scrolled up.
				reconcileSealedTurn(tabId, event.turnId);
				// Reconcile cacheStats to the DB source-of-truth carried on the event.
				// REPLACE (not add): the aggregate already includes every persisted
				// usage row for this tab, so this both lands the just-sealed turn's
				// usage AND self-heals any live overshoot (e.g. a rate-limited
				// fallback attempt streamed usage live but was discarded server-side).
				// `usageStats === undefined` (older backend) leaves cacheStats as-is.
				if (event.usageStats !== undefined) {
					updateTab(tabId, { cacheStats: event.usageStats ?? undefined });
				}
				break;
			}
			case "statuses": {
				// WS (re)connect snapshot. The shape was widened to
				// TabStatusSnapshot (status + optional currentChunks +
				// optional currentAssistantId) so the frontend can seed
				// in-flight assistant messages on browser reopen.
				const backend = event.statuses;
				for (const t of tabs) {
					const snap = backend[t.id];
					const backendStatus = snap?.status ?? "idle";

					// Desync case: frontend thought it was streaming, backend
					// has already moved on. The turn is persisted now — reload
					// the chunk window so the final answer shows up.
					if (t.agentStatus === "running" && backendStatus !== "running") {
						void reloadChunksFromApi(t.id);
					}

					// Status alignment.
					if (t.agentStatus !== backendStatus) {
						updateTab(t.id, { agentStatus: backendStatus });
					}

					// Rehydrate the todo list from the snapshot (backend truth)
					// so a reconnect/reload doesn't blank the Tasks panel.
					updateTab(t.id, { tasks: snap?.tasks ?? [] });

					if (backendStatus === "running") {
						// Seed the in-flight assistant message from the snapshot.
						// This handles the "browser just reopened mid-stream"
						// path: the DB only has chunks up to the last
						// flushAssistant call, but the snapshot has the live
						// in-memory currentChunks.
						if (snap?.currentAssistantId) {
							const targetId = snap.currentAssistantId;
							updateTab(t.id, {
								currentAssistantId: targetId,
								...(snap.currentTurnId ? { liveTurnId: snap.currentTurnId } : {}),
							});
							updateLive(t.id, (msgs) => {
								const idx = msgs.findIndex((m) => m.id === targetId);
								if (idx >= 0) {
									return msgs.map((m, i) =>
										i === idx
											? {
													...m,
													chunks: snap.currentChunks ? [...snap.currentChunks] : m.chunks,
													isStreaming: true,
												}
											: m,
									);
								}
								return [
									...msgs,
									{
										id: targetId,
										role: "assistant",
										chunks: snap.currentChunks ? [...snap.currentChunks] : [],
										isStreaming: true,
										...(snap.currentTurnId ? { turnId: snap.currentTurnId } : {}),
									},
								];
							});
						}
					} else if (t.currentAssistantId) {
						// Not running: clear streaming flags.
						updateLive(t.id, (msgs) =>
							msgs.map((m) => (m.id === t.currentAssistantId ? { ...m, isStreaming: false } : m)),
						);
						updateTab(t.id, { currentAssistantId: null });
					}
				}
				break;
			}
			case "reasoning-delta":
			case "reasoning-end":
			case "text-delta":
			case "tool-call":
			case "tool-result":
			case "shell-output": {
				if (!tabId) break;
				applyChunkEvent(tabId, event);
				break;
			}
			case "usage": {
				if (!tabId) break;
				const tab = getTabById(tabId);
				if (!tab) break;
				const u = event.usage;
				const prev = tab.cacheStats;
				updateTab(tabId, {
					cacheStats: {
						inputTokens: (prev?.inputTokens ?? 0) + u.inputTokens,
						outputTokens: (prev?.outputTokens ?? 0) + u.outputTokens,
						cacheReadTokens: (prev?.cacheReadTokens ?? 0) + u.cacheReadTokens,
						cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + u.cacheWriteTokens,
						requests: (prev?.requests ?? 0) + 1,
						last: {
							inputTokens: u.inputTokens,
							outputTokens: u.outputTokens,
							cacheReadTokens: u.cacheReadTokens,
							cacheWriteTokens: u.cacheWriteTokens,
						},
					},
				});
				break;
			}
			case "done": {
				if (!tabId) break;
				const tab5 = getTabById(tabId);
				if (!tab5) break;
				updateLive(tabId, (msgs) =>
					msgs.map((m) => (m.id === tab5.currentAssistantId ? { ...m, isStreaming: false } : m)),
				);
				updateTab(tabId, { currentAssistantId: null });
				break;
			}
			case "error": {
				if (!tabId) break;
				const errTab = getTabById(tabId);
				if (!errTab) break;
				if (errTab.currentAssistantId) {
					// In-flight turn: append the error as a chunk on the
					// assistant message via the shared helper. Mark debug info
					// on the message for parity with the previous behavior.
					applyChunkEvent(tabId, event);
					updateLive(tabId, (msgs) =>
						msgs.map((m) =>
							m.id === errTab.currentAssistantId
								? {
										...m,
										isStreaming: false,
										debugInfo: makeDebugInfo({ error: event.error }),
									}
								: m,
						),
					);
				} else {
					// No turn in flight: open a new assistant message holding
					// only the error chunk. We do this by ensuring an assistant
					// message then funneling through applyChunkEvent, which
					// guarantees the chunk shape matches the helper's output.
					ensureAssistantMessage(tabId);
					applyChunkEvent(tabId, event);
					const afterTab = getTabById(tabId);
					if (afterTab?.currentAssistantId) {
						const newId = afterTab.currentAssistantId;
						updateLive(tabId, (msgs) =>
							msgs.map((m) =>
								m.id === newId
									? {
											...m,
											isStreaming: false,
											debugInfo: makeDebugInfo({ error: event.error }),
										}
									: m,
							),
						);
					}
				}
				updateTab(tabId, { currentAssistantId: null, agentStatus: "error" });
				break;
			}
			case "notice": {
				if (!tabId) break;
				const noticeTab = getTabById(tabId);
				if (!noticeTab) break;
				if (noticeTab.currentAssistantId) {
					applyChunkEvent(tabId, event);
				} else {
					routeSystemEvent(tabId, { kind: "notice", text: event.message });
				}
				break;
			}
			case "model-changed": {
				if (!tabId) break;
				const mcTab2 = getTabById(tabId);
				if (!mcTab2) break;
				// Always update the tab's active key/model. Additionally emit
				// a `system` chunk to record the switch at its temporal
				// position (in the assistant turn if one is in flight; else
				// in a standalone system message).
				updateTab(tabId, { keyId: event.keyId, modelId: event.modelId });
				if (mcTab2.currentAssistantId) {
					applyChunkEvent(tabId, event);
				} else {
					routeSystemEvent(tabId, {
						kind: "model-changed",
						text: `Switched to ${event.modelId} (${event.keyId})`,
					});
				}
				break;
			}
			case "permission-prompt": {
				pendingPermissions = event.pending;
				break;
			}
			case "task-list-update": {
				if (tabId) {
					updateTab(tabId, { tasks: event.tasks });
				}
				break;
			}
			case "config-reload": {
				configReloaded = true;
				setTimeout(() => {
					configReloaded = false;
				}, 2500);
				// If a tab + turn is in flight, also record the reload as a
				// system chunk for honest history. If no turn is in flight we
				// could route to a system message, but config-reload is a
				// global signal not scoped to any tab — only the active tab,
				// if any, gets the chunk.
				if (tabId) {
					const crTab = getTabById(tabId);
					if (crTab?.currentAssistantId) {
						applyChunkEvent(tabId, event);
					}
				}
				break;
			}
			case "tab-created": {
				const newTabEvent = event as AgentEvent & {
					id: string;
					title: string;
					keyId: string | null;
					modelId: string | null;
					parentTabId: string | null;
					agentSlug?: string | null;
					workingDirectory: string | null;
					agentModels?: AgentModelEntry[] | null;
				};
				// Only add if we don't already have this tab
				if (!getTabById(newTabEvent.id)) {
					const tab: Tab = {
						id: newTabEvent.id,
						title: newTabEvent.title,
						chunks: [],
						live: [],
						renderGroups: [],
						liveTurnId: null,
						agentStatus: "running",
						keyId: newTabEvent.keyId ?? null,
						modelId: newTabEvent.modelId ?? null,
						reasoningEffort: DEFAULT_REASONING_EFFORT,
						currentAssistantId: null,
						tasks: [],
						injectedSkills: [],
						parentTabId: newTabEvent.parentTabId ?? null,
						persistent: newTabEvent.parentTabId == null,
						agentSlug: newTabEvent.agentSlug ?? null,
						agentScope: null,
						agentModels: newTabEvent.agentModels ?? null,
						workingDirectory: newTabEvent.workingDirectory ?? null,
						queuedMessages: [],
						chunkLimit: appSettings.chunkLimit,
						draft: "",
						attachments: [],
						manualTitle: false,
						oldestLoadedSeq: null,
						totalChunks: 0,
					};
					tabs = [...tabs, tab];
				}
				break;
			}
			case "message-queued": {
				if (!tabId) break;
				const mqEvent = event as AgentEvent & { tabId: string; messageId: string; message: string };
				const mqTab = getTabById(tabId);
				if (!mqTab) break;
				// Only add to queuedMessages if not already tracked (might have been added
				// optimistically by sendMessage using the same queueId)
				const alreadyQueued = mqTab.queuedMessages.some((m) => m.id === mqEvent.messageId);
				if (!alreadyQueued) {
					// Message came from another client/session — add it fresh
					const qm: QueuedMessage = {
						id: mqEvent.messageId,
						message: mqEvent.message,
						timestamp: Date.now(),
					};
					updateTab(tabId, { queuedMessages: [...mqTab.queuedMessages, qm] });
					// Also add as a user message in the live tail if not present.
					const tabAfterQm = getTabById(tabId);
					const existingMsg = tabAfterQm?.live.find(
						(m) => m.id === `queued-${mqEvent.messageId}` || m.id === mqEvent.messageId,
					);
					if (!existingMsg) {
						const userMsg: ChatMessage = {
							id: `queued-${mqEvent.messageId}`,
							role: "user",
							chunks: [{ type: "text", text: mqEvent.message }],
						};
						updateTab(tabId, { live: [...(tabAfterQm?.live ?? []), userMsg] });
					}
				}
				// If alreadyQueued, the optimistic update already put everything in place with the
				// correct `queued-${messageId}` id — nothing more to do.
				break;
			}
			case "message-consumed": {
				if (!tabId) break;
				const mcEvent = event as AgentEvent & {
					tabId: string;
					messageIds: string[];
					reason?: "interrupt" | "continuation";
				};
				const mcTab = getTabById(tabId);
				if (!mcTab) break;
				// Track recently consumed IDs so sendMessage can detect early consumption
				for (const id of mcEvent.messageIds) {
					recentlyConsumedIds.add(id);
					setTimeout(() => recentlyConsumedIds.delete(id), 10000);
				}
				updateTab(tabId, {
					queuedMessages: mcTab.queuedMessages.filter((m) => !mcEvent.messageIds.includes(m.id)),
				});

				// "continuation" — these queued messages are draining BETWEEN turns
				// to START a fresh turn (the "queue consumed after turn ends" path),
				// not folding into a running turn's tool result. The backend joins
				// them into ONE initiating user row, so we collapse the matching
				// optimistic `queued-` bubbles into a single UNTAGGED user row. It
				// stays untagged on purpose: the imminent `turn-start` tags it as
				// this new turn's initiator (exactly like a normal send), and
				// reconcile then folds it into the sealed turn. Leaving N separate
				// untagged rows would strand all but the most-recent one (turn-start
				// only tags one), so collapsing is required.
				if (mcEvent.reason === "continuation") {
					updateLive(tabId, (msgs) => {
						const consumedTexts: string[] = [];
						const rest: ChatMessage[] = [];
						let firstConsumedIdx = -1;
						for (const m of msgs) {
							if (m.role === "user" && m.id.startsWith("queued-")) {
								const queuedId = m.id.slice(7);
								if (mcEvent.messageIds.includes(queuedId)) {
									if (firstConsumedIdx === -1) firstConsumedIdx = rest.length;
									const textChunk = m.chunks.find((c) => c.type === "text");
									consumedTexts.push(textChunk && textChunk.type === "text" ? textChunk.text : "");
									continue;
								}
							}
							rest.push(m);
						}
						if (consumedTexts.length === 0) return msgs;
						const initiator: ChatMessage = {
							id: generateId(),
							role: "user",
							chunks: [{ type: "text", text: consumedTexts.join("\n---\n") }],
						};
						rest.splice(firstConsumedIdx === -1 ? rest.length : firstConsumedIdx, 0, initiator);
						return rest;
					});
					break;
				}

				// Split the current assistant message: finalize it, then insert
				// the consumed user messages after it. Subsequent streaming events
				// will create a NEW assistant message block below.
				const currentAssistantId = mcTab.currentAssistantId;
				updateLive(tabId, (msgs) => {
					// Extract consumed messages
					const consumed: ChatMessage[] = [];
					const rest: ChatMessage[] = [];
					for (const m of msgs) {
						if (m.id.startsWith("queued-")) {
							const queuedId = m.id.slice(7);
							if (mcEvent.messageIds.includes(queuedId)) {
								// Bind the consumed message to the in-flight turn that is
								// consuming it. Stripping the `queued-` prefix alone leaves
								// it an UNTAGGED user row, which reconcileSealedTurn KEEPS —
								// so the interrupt bubble would linger in the live tail
								// forever AND duplicate the `[USER INTERRUPT]` text the
								// backend folds into the sealed tool-result chunk. Tagging
								// it lets reconcile drop it on seal, collapsing to the
								// persisted shape. (liveTurnId is set for the duration of a
								// running turn, which is the only time a consume happens.)
								consumed.push({
									...m,
									id: queuedId,
									...(mcTab.liveTurnId !== null ? { turnId: mcTab.liveTurnId } : {}),
								});
								continue;
							}
						}
						rest.push(m);
					}
					if (consumed.length === 0) return msgs;

					// Mark the current assistant message as done streaming
					const result = rest.map((m) =>
						m.id === currentAssistantId ? { ...m, isStreaming: false } : m,
					);

					// Insert consumed messages right after the current assistant message
					let insertIdx = result.length;
					for (let i = result.length - 1; i >= 0; i--) {
						if (result[i]?.id === currentAssistantId) {
							insertIdx = i + 1;
							break;
						}
					}
					result.splice(insertIdx, 0, ...consumed);
					return result;
				});
				// Clear currentAssistantId so the next streaming event creates
				// a new assistant message block after the user's message
				updateTab(tabId, { currentAssistantId: null });
				break;
			}
			case "message-cancelled": {
				if (!tabId) break;
				const cancelEvent = event as AgentEvent & { tabId: string; messageId: string };
				const cancelTab = getTabById(tabId);
				if (!cancelTab) break;
				updateTab(tabId, {
					queuedMessages: cancelTab.queuedMessages.filter((m) => m.id !== cancelEvent.messageId),
					live: cancelTab.live.filter(
						(m) => !(m.role === "user" && m.id === `queued-${cancelEvent.messageId}`),
					),
				});
				break;
			}
		}
	}

	async function autoCheckDefaultSkills(): Promise<void> {
		try {
			const res = await fetch(`${config.apiBase}/skills`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				skills?: Array<{
					name: string;
					scope: string;
					directory: string;
				}>;
			};
			const defaultSkills = (data.skills ?? []).filter((s) => s.directory === "default");
			if (defaultSkills.length === 0) return;
			const checks: Record<string, boolean> = { ...appSettings.skillChecks };
			for (const skill of defaultSkills) {
				checks[`${skill.scope}:${skill.name}`] = true;
			}
			appSettings.skillChecks = checks;
		} catch {
			// Silently ignore — skills will still be available for manual checking
		}
	}

	async function autoSelectDefaultAgent(tabId: string): Promise<void> {
		try {
			const res = await fetch(`${config.apiBase}/agents`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				agents?: Array<{
					slug: string;
					scope: string;
					name: string;
					skills: string[];
					tools: string[];
					models: AgentModelEntry[];
					cwd?: string;
				}>;
			};
			const agents = data.agents ?? [];
			const defaultAgent = agents.find(
				(a: { slug: string; scope: string }) => a.slug === "default" && a.scope === "global",
			);
			if (!defaultAgent) return;

			const tab = getTabById(tabId);
			if (!tab) return;

			// Apply the default agent
			const firstModel = defaultAgent.models[0];
			const patch: Partial<Tab> = {
				agentSlug: defaultAgent.slug,
				agentScope: defaultAgent.scope,
				agentModels: defaultAgent.models,
				workingDirectory: defaultAgent.cwd || null,
			};
			if (firstModel) {
				patch.keyId = firstModel.key_id;
				patch.modelId = firstModel.model_id;
			}
			updateTab(tabId, patch);

			// Merge the agent's skills into existing checked skills
			if (defaultAgent.skills.length > 0) {
				const checks: Record<string, boolean> = { ...appSettings.skillChecks };
				for (const skillKey of defaultAgent.skills) {
					checks[skillKey] = true;
				}
				appSettings.skillChecks = checks;
			}

			// Apply tool permissions
			const perms: Record<string, boolean> = {};
			for (const key of Object.keys(appSettings.toolPerms)) {
				perms[key] = false;
			}
			for (const tool of defaultAgent.tools) {
				perms[tool] = true;
			}
			appSettings.toolPerms = perms;

			// Persist to backend
			if (firstModel) {
				fetch(`${config.apiBase}/tabs/${tabId}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keyId: firstModel.key_id, modelId: firstModel.model_id }),
				}).catch(() => {});
			}
		} catch {
			// Silently ignore
		}
	}

	async function refreshAgentConfig(tabId: string): Promise<void> {
		const tab = getTabById(tabId);
		if (!tab?.agentSlug || !tab.agentScope) return;
		try {
			const res = await fetch(`${config.apiBase}/agents`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				agents?: Array<{
					slug: string;
					scope: string;
					models: AgentModelEntry[];
					cwd?: string;
				}>;
			};
			const agents = data.agents ?? [];
			const freshAgent = agents.find((a) => a.slug === tab.agentSlug && a.scope === tab.agentScope);
			if (!freshAgent) return;
			const patch: Partial<Tab> = {
				agentModels: freshAgent.models,
				// NOTE: do not reset workingDirectory here. It is a per-tab user
				// setting (see setWorkingDirectory); refreshing agent config on
				// send must not clobber the directory the user chose for this tab.
			};
			// Preserve the user's current selection if it still exists in the
			// refreshed models list. Only fall back to the first model when the
			// current selection is no longer valid.
			const currentStillValid = freshAgent.models.some(
				(m) => m.key_id === tab.keyId && m.model_id === tab.modelId,
			);
			if (!currentStillValid) {
				const firstModel = freshAgent.models[0];
				if (firstModel) {
					patch.keyId = firstModel.key_id;
					patch.modelId = firstModel.model_id;
				} else {
					patch.keyId = null;
					patch.modelId = null;
				}
			}
			updateTab(tabId, patch);
		} catch {
			// Silently fall back to stale values
		}
	}

	async function fetchSkillContent(scope: string, name: string): Promise<string | null> {
		try {
			const res = await fetch(
				`${config.apiBase}/skills/${encodeURIComponent(name)}?scope=${scope}`,
			);
			if (!res.ok) return null;
			const data = (await res.json()) as { content?: string };
			return data.content ?? null;
		} catch {
			return null;
		}
	}

	async function sendMessage(text: string, content?: UserContentPart[]): Promise<void> {
		let tab = getActiveTab();
		if (!tab) return;

		// Refresh agent config to pick up any changes made in AgentBuilder
		if (tab.agentSlug && tab.agentScope) {
			await refreshAgentConfig(tab.id);
			tab = getActiveTab();
			if (!tab) return;
		}

		// Fetch content for checked skills and build the message to send.
		// `skillPrefix` (when non-empty) is prepended to BOTH the text projection
		// that gets persisted/rendered AND the multimodal content array, so an
		// image turn still carries the activated skills to the model.
		let skillPrefix = "";
		const checkedKeys = Object.entries(appSettings.skillChecks)
			.filter(([, v]) => v)
			.map(([k]) => k);

		if (checkedKeys.length > 0) {
			const skillSections: string[] = [];
			for (const key of checkedKeys) {
				const [scope, ...nameParts] = key.split(":");
				const name = nameParts.join(":");
				if (!scope || !name) continue;
				const skillContent = await fetchSkillContent(scope, name);
				if (skillContent) {
					skillSections.push(`<skill name="${name}">\n${skillContent}\n</skill>`);
				}
			}
			if (skillSections.length > 0) {
				skillPrefix = `[The following skills have been activated for this message]\n\n${skillSections.join("\n\n")}\n\n---\n\n`;
			}

			// Track injected skills on the tab
			const newInjected = [...new Set([...tab.injectedSkills, ...checkedKeys])];
			updateTab(tab.id, { injectedSkills: newInjected });

			// Clear all checks
			appSettings.skillChecks = {};
		}

		const messageToSend = `${skillPrefix}${text}`;
		// Prepend the skill prefix to the multimodal content as a leading text
		// part so the model sees the activated skills before the attachments.
		const contentToSend =
			content && skillPrefix ? [{ type: "text" as const, text: skillPrefix }, ...content] : content;

		const userMsg: ChatMessage = {
			id: generateId(),
			role: "user",
			chunks: [{ type: "text", text }],
		};

		// If the agent is currently running, we expect the POST to be queued.
		// Optimistically assign the queued- prefix and add to queuedMessages BEFORE
		// the POST so that the WS "message-queued" event (which may arrive before
		// the HTTP response) can match the existing chat message instead of creating
		// a duplicate.
		const isRunning = tab.agentStatus === "running";
		let queueId: string | null = null;
		if (isRunning) {
			queueId = generateId();
			userMsg.id = `queued-${queueId}`;
			// Pre-populate queuedMessages so WS event finds it immediately
			tab.queuedMessages = [
				...tab.queuedMessages,
				{ id: queueId, message: text, timestamp: Date.now() },
			];
		}

		// Optimistically show the user's message in the live tail.
		updateTab(tab.id, { live: [...tab.live, userMsg] });
		// Generate a title from the first user message of an empty tab.
		const isFirstMessage = tab.chunks.length === 0 && tab.live.length === 0;
		if (!tab.manualTitle && (isFirstMessage || tab.title === "New Tab")) {
			const titleText = text.length > 50 ? `${text.slice(0, 47)}...` : text;
			updateTab(tab.id, { title: titleText });
			fetch(`${config.apiBase}/tabs/${tab.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: titleText }),
			}).catch(() => {});
		}

		// Save settings to DB before sending (bakes in on send)
		const settingsSaves: Promise<unknown>[] = [];

		if (appSettings.systemPrompt !== appSettings.savedSystemPrompt) {
			appSettings.savedSystemPrompt = appSettings.systemPrompt;
			settingsSaves.push(
				fetch(`${config.apiBase}/tabs/settings/system_prompt`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ value: appSettings.systemPrompt }),
				}).catch(() => {}),
			);
		}

		if (appSettings.toolPermsDirty) {
			const perms = appSettings.toolPerms;
			appSettings.savedToolPerms = { ...perms };
			for (const [id, enabled] of Object.entries(perms)) {
				settingsSaves.push(
					fetch(`${config.apiBase}/tabs/settings/perm_${id}`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ value: enabled ? "allow" : "ask" }),
					}).catch(() => {}),
				);
			}
		}

		if (settingsSaves.length > 0) {
			await Promise.all(settingsSaves);
		}

		try {
			const res = await fetch(`${config.apiBase}/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					tabId: tab.id,
					message: messageToSend,
					...(contentToSend ? { content: contentToSend } : {}),
					...(tab.keyId ? { keyId: tab.keyId } : {}),
					...(tab.modelId ? { modelId: tab.modelId } : {}),
					...(tab.agentModels ? { agentModels: tab.agentModels } : {}),
					reasoningEffort: tab.reasoningEffort,
					...(tab.workingDirectory ? { workingDirectory: tab.workingDirectory } : {}),
					...(queueId ? { queueId } : {}),
				}),
			});
			if (!res.ok) {
				const body = await res.text();
				// Rollback optimistic queued state on error
				if (queueId) {
					const currentTab = getTabById(tab.id);
					if (currentTab) {
						updateTab(tab.id, {
							queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
						});
					}
					updateLive(tab.id, (msgs) =>
						msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
					);
				}
				const errMsg: ChatMessage = {
					id: generateId(),
					role: "assistant",
					chunks: [
						{
							type: "error",
							message: `Failed to send message (HTTP ${res.status})`,
							statusCode: res.status,
						},
					],
					isStreaming: false,
					debugInfo: makeDebugInfo({
						error: `HTTP ${res.status}`,
						httpStatus: res.status,
						httpBody: body,
					}),
				};
				updateTab(tab.id, { live: [...(getTabById(tab.id)?.live ?? []), errMsg] });
			} else {
				const responseData = (await res.json()) as { status: string; messageId?: string };
				if (responseData.status === "queued" && responseData.messageId) {
					// The backend confirmed the message was queued with the ID we sent (queueId).
					// If the message was already consumed before we got here (super-fast agent),
					// clean up the optimistic queued state.
					if (queueId && recentlyConsumedIds.has(queueId)) {
						recentlyConsumedIds.delete(queueId);
						// queuedMessages and the queued- prefix have already been cleaned up by
						// the message-consumed handler. Nothing more to do.
					}
					// Otherwise everything is already in place from the optimistic update above.
				} else if (responseData.status === "ok") {
					// Agent wasn't running after all — undo the optimistic queued state if we set it.
					if (queueId) {
						const currentTab = getTabById(tab.id);
						if (currentTab) {
							updateTab(tab.id, {
								queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
							});
						}
						// Restore the message to a normal (non-queued) ID
						updateLive(tab.id, (msgs) =>
							msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
						);
					}
				}
			}
		} catch (err) {
			// Rollback optimistic queued state on network error
			if (queueId) {
				const currentTab = getTabById(tab.id);
				if (currentTab) {
					updateTab(tab.id, {
						queuedMessages: currentTab.queuedMessages.filter((m) => m.id !== queueId),
					});
				}
				updateLive(tab.id, (msgs) =>
					msgs.map((m) => (m.id === `queued-${queueId}` ? { ...m, id: generateId() } : m)),
				);
			}
			const errMsg: ChatMessage = {
				id: generateId(),
				role: "assistant",
				chunks: [{ type: "error", message: "Could not reach the server" }],
				isStreaming: false,
				debugInfo: makeDebugInfo({ error: err instanceof Error ? err.message : String(err) }),
			};
			updateTab(tab.id, { live: [...(getTabById(tab.id)?.live ?? []), errMsg] });
		}
	}

	function changeModel(keyId: string, modelId: string): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { keyId, modelId });

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId, modelId }),
		}).catch(() => {});
	}

	function setKey(keyId: string): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { keyId, modelId: null });

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ keyId, modelId: null }),
		}).catch(() => {});
	}

	/**
	 * Update the per-tab reasoning-effort selector. Ignores unrecognised
	 * values so an out-of-range string from the UI can't corrupt the tab
	 * state. This is the per-tab effort in the per-model → per-tab → default
	 * resolution chain.
	 */
	function setReasoningEffort(effort: string): void {
		if (!isReasoningEffort(effort)) return;
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { reasoningEffort: effort });
	}

	function setWorkingDirectory(dir: string | null): void {
		const tab = getActiveTab();
		if (!tab) return;
		updateTab(tab.id, { workingDirectory: dir || null });
	}

	function setAgent(
		agent: {
			slug: string;
			scope: string;
			skills: string[];
			tools: string[];
			models: AgentModelEntry[];
			cwd?: string;
		} | null,
	): void {
		const tab = getActiveTab();
		if (!tab) return;

		if (!agent) {
			// Switch back to manual mode — clear agent and reset working directory
			updateTab(tab.id, {
				agentSlug: null,
				agentScope: null,
				agentModels: null,
				workingDirectory: null,
			});
			return;
		}

		// Apply agent's first model as the active key+model
		const firstModel = agent.models[0];
		const patch: Partial<Tab> = {
			agentSlug: agent.slug,
			agentScope: agent.scope,
			agentModels: agent.models,
			workingDirectory: agent.cwd || null,
		};
		if (firstModel) {
			patch.keyId = firstModel.key_id;
			patch.modelId = firstModel.model_id;
		}
		updateTab(tab.id, patch);

		// Reset and apply the agent's skills (don't accumulate from previous agents)
		const checks: Record<string, boolean> = {};
		for (const skillKey of agent.skills) {
			checks[skillKey] = true;
		}
		appSettings.skillChecks = checks;

		// Always reset tool permissions to agent's allowlist (even if empty)
		const perms: Record<string, boolean> = {};
		for (const key of Object.keys(appSettings.toolPerms)) {
			perms[key] = false;
		}
		for (const tool of agent.tools) {
			perms[tool] = true;
		}
		appSettings.toolPerms = perms;

		// Persist to backend
		fetch(`${config.apiBase}/tabs/${tab.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...(firstModel ? { keyId: firstModel.key_id, modelId: firstModel.model_id } : {}),
			}),
		}).catch(() => {});
	}

	function replyPermission(id: string, reply: "once" | "always" | "reject"): void {
		if (wsClient.connectionStatus !== "connected") return;
		const prompt = pendingPermissions.find((p) => p.id === id);
		wsClient.send({ type: "permission-reply", id, reply });
		pendingPermissions = pendingPermissions.filter((p) => p.id !== id);
		if (prompt) {
			permissionLog = [
				...permissionLog,
				{
					id: generateId(),
					permission: prompt.permission,
					patterns: prompt.patterns,
					action: reply,
					timestamp: new Date().toISOString(),
					description: prompt.description,
				},
			];
		}
	}

	async function cancelQueuedMessage(tabId: string, messageId: string): Promise<void> {
		const tab = getTabById(tabId);
		if (tab) {
			updateTab(tabId, {
				queuedMessages: tab.queuedMessages.filter((m) => m.id !== messageId),
				live: tab.live.filter((m) => !(m.role === "user" && m.id === `queued-${messageId}`)),
			});
		}
		try {
			await fetch(`${config.apiBase}/chat/cancel`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tabId, messageId }),
			});
		} catch {
			// ignore
		}
	}

	async function stopGeneration(tabId: string): Promise<void> {
		try {
			await fetch(`${config.apiBase}/chat/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ tabId }),
			});
		} catch {
			// ignore
		}
	}

	function copyConversation(): string {
		const tab = getActiveTab();
		if (!tab) return "";

		const enabledTools = Object.entries(appSettings.savedToolPerms)
			.filter(([, v]) => v)
			.map(([k]) => k);

		// Short, distinguishable chunk descriptor — lets us see the shape of
		// each message at a glance without dumping the full content.
		// E.g. `chunks=6: thinking, tool-batch[2], thinking, tool-batch[1], thinking, text`.
		// If a message reports `chunks=0`, the in-memory store has no content
		// for it — which is the canonical symptom of a wire-format / load
		// failure. Always include this so bug reports are diagnosable from
		// the paste alone, without DB access.
		const summarizeChunks = (chunks: (typeof tab.renderGroups)[number]["chunks"]) => {
			if (chunks.length === 0) return "chunks=0";
			const parts = chunks.map((c) => {
				if (c.type === "tool-batch") return `tool-batch[${c.calls.length}]`;
				if (c.type === "system") return `system:${c.kind}`;
				return c.type; // text | thinking | error
			});
			return `chunks=${chunks.length}: ${parts.join(", ")}`;
		};

		const shortId = (id: string | undefined) => (id ? `${id.slice(0, 8)}…` : "?");

		const lines: string[] = [
			"=== Dispatch Conversation ===",
			`Tab ID: ${tab.id}`,
			`Tab: ${tab.title}`,
			`Model: ${tab.modelId ?? "default"}`,
			`Tools: ${enabledTools.length > 0 ? enabledTools.join(", ") : "none"}`,
			`Injected Skills: ${tab.injectedSkills.length > 0 ? tab.injectedSkills.join(", ") : "none"}`,
			`Total tabs: ${tabs.length}`,
			`All tab IDs: ${tabs.map((t) => t.id).join(", ")}`,
			"",
			// Store-level state — distinguishes "store empty (load/parse
			// failure)" from "store populated, agent stuck mid-stream" from
			// "agent finished cleanly" etc.
			"--- Frontend store state ---",
			`Connected to backend: ${isConnected}`,
			`Tab agentStatus: ${tab.agentStatus}`,
			`Tab currentAssistantId: ${tab.currentAssistantId ?? "null"}`,
			`Render groups in store: ${tab.renderGroups.length}`,
			`Queued messages: ${tab.queuedMessages.length}`,
			`Persistent: ${tab.persistent}`,
			`Working directory: ${tab.workingDirectory ?? "default"}`,
			`Reasoning effort: ${tab.reasoningEffort}`,
			`Todos: ${tab.tasks.length} (${tab.tasks.filter((t) => t.status === "completed").length} completed)`,
			"",
		];
		const TOOL_RESULT_MAX = 300;

		for (const msg of tab.renderGroups) {
			const role = msg.role === "user" ? "User" : msg.role === "system" ? "System" : "Assistant";
			const streamingFlag = msg.isStreaming ? ", streaming=true" : "";
			// Inline message diagnostics — id, streaming, chunk summary —
			// makes wire-format / store-shape bugs immediately visible.
			lines.push(
				`--- ${role} --- (id=${shortId(msg.id)}${streamingFlag}, ${summarizeChunks(msg.chunks)})`,
			);

			// Surface non-trivial debugInfo (errors, HTTP failures). Skip
			// when there's nothing interesting — keeps the output readable
			// for happy-path conversations.
			const dbg = msg.debugInfo;
			if (dbg && (dbg.error || dbg.httpStatus !== undefined || dbg.httpBody)) {
				const dbgBits: string[] = [];
				if (dbg.error) dbgBits.push(`error="${dbg.error}"`);
				if (dbg.httpStatus !== undefined) dbgBits.push(`httpStatus=${dbg.httpStatus}`);
				if (dbg.httpBody) {
					const body = dbg.httpBody.length > 200 ? `${dbg.httpBody.slice(0, 200)}…` : dbg.httpBody;
					dbgBits.push(`httpBody="${body}"`);
				}
				lines.push(`  [debug]: ${dbgBits.join(" ")}`);
			}

			for (const chunk of msg.chunks) {
				switch (chunk.type) {
					case "text":
						lines.push(chunk.text);
						break;
					case "thinking":
						lines.push(`  [Thinking]: ${chunk.text}`);
						break;
					case "tool-batch":
						for (const call of chunk.calls) {
							lines.push(`  [Tool: ${call.name}]`);
							if (call.result !== undefined) {
								const result = String(call.result);
								if (result.length > TOOL_RESULT_MAX) {
									lines.push(
										`  Result: ${result.slice(0, TOOL_RESULT_MAX)}... [truncated, ${result.length} chars total]`,
									);
								} else {
									lines.push(`  Result: ${result}`);
								}
							}
						}
						break;
					case "error": {
						const code = chunk.statusCode !== undefined ? ` (HTTP ${chunk.statusCode})` : "";
						lines.push(`  [Error${code}]: ${chunk.message}`);
						break;
					}
					case "system":
						lines.push(`  [${chunk.kind}]: ${chunk.text}`);
						break;
				}
			}
			lines.push("");
		}
		return lines.join("\n");
	}

	return {
		get tabs() {
			return tabs;
		},
		get activeTabId() {
			return activeTabId;
		},
		get activeTab() {
			return getActiveTab();
		},
		get isConnected() {
			return isConnected;
		},
		get pendingPermissions() {
			return pendingPermissions;
		},
		get permissionLog() {
			return permissionLog;
		},
		get configReloaded() {
			return configReloaded;
		},
		shortHandleFor,
		createNewTab,
		switchTab,
		closeTab,
		renameTab,
		reorderTabs,
		setDraft,
		addAttachment,
		sendMessage,
		cancelQueuedMessage,
		stopGeneration,
		changeModel,
		setKey,
		setReasoningEffort,
		setAgent,
		replyPermission,
		copyConversation,
		promoteTab,
		openAgentTab,
		setWorkingDirectory,
		// Exposed so tests can drive the real reactive code path that the
		// WS callback uses in production. Not intended for use in
		// components — they should rely on the WS subscription instead.
		handleEvent,
		hydrateFromBackend,
		loadOlderChunks,
		evictChunks,
		setScrolledUp,
	};
}

export const tabStore = createTabStore();
