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
import { config } from "./config.js";
import { appSettings } from "./settings.svelte.js";
import type {
	AgentEvent,
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

/**
 * Extract the smallest `seq` from a list of raw API message rows. The backend
 * tags each persisted message with a monotonic `seq`; we track the oldest one
 * currently loaded so `loadMoreMessages` can page backwards via `?before=seq`.
 * Returns null when no row carries a usable seq.
 */
function oldestSeqOf(messages: Array<{ seq?: number }>): number | null {
	let min: number | null = null;
	for (const m of messages) {
		if (typeof m.seq === "number" && (min === null || m.seq < min)) {
			min = m.seq;
		}
	}
	return min;
}

function makeDebugInfo(overrides: Partial<DebugInfo> = {}): DebugInfo {
	return {
		timestamp: new Date().toISOString(),
		connectionStatus: wsClient.connectionStatus,
		...overrides,
	};
}

export interface Tab {
	id: string;
	title: string;
	messages: ChatMessage[];
	agentStatus: "idle" | "running" | "error";
	keyId: string | null;
	modelId: string | null;
	reasoningEffort: string;
	currentAssistantId: string | null;
	tasks: TaskItem[];
	injectedSkills: string[];
	/** null = user-owned tab, string = spawned by that tab */
	parentTabId: string | null;
	/** Persistent tabs stay until manually closed. Temp tabs disappear when agent finishes. */
	persistent: boolean;
	/** Slug of the selected agent, or null for manual mode */
	agentSlug: string | null;
	/** Scope of the selected agent */
	agentScope: string | null;
	/** Ordered key+model fallback hierarchy from the selected agent */
	agentModels: Array<{ key_id: string; model_id: string }> | null;
	/** Custom working directory override for this tab */
	workingDirectory: string | null;
	/** Messages queued to be sent once the agent finishes its current run */
	queuedMessages: QueuedMessage[];
	/** Max chunks to keep in memory before evicting oldest messages */
	chunkLimit: number;
	/** Seq of the oldest message currently loaded, or null if unknown/none */
	oldestLoadedSeq: number | null;
	/** Total number of messages for this tab on the backend */
	totalMessages: number;
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
			messages: [],
			agentStatus: "idle",
			keyId: null,
			modelId: null,
			reasoningEffort: "max",
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
			oldestLoadedSeq: null,
			totalMessages: 0,
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

			const messagesRes = await fetch(`${config.apiBase}/tabs/${agentId}/messages?limit=100`);
			// The backend's `getMessagesForTab` (packages/core/src/db/messages.ts)
			// already parses `content_json` into a `Chunk[]` and serves it as
			// `chunks` over the wire — NOT the raw `contentJson` string. Earlier
			// versions of this client expected `contentJson` and silently dropped
			// every message when JSON.parse(undefined) threw, leaving the UI
			// with empty conversations after a refresh.
			const messagesData = messagesRes.ok
				? ((await messagesRes.json()) as {
						messages: Array<{
							id?: string;
							role: string;
							chunks?: Chunk[];
							seq?: number;
						}>;
						total?: number;
					})
				: { messages: [], total: 0 };

			const chatMessages: ChatMessage[] = messagesData.messages.map((m) => ({
				id: m.id ?? generateId(),
				role: m.role as ChatMessage["role"],
				chunks: Array.isArray(m.chunks) ? m.chunks : [],
				isStreaming: false,
				seq: m.seq,
			}));

			const newTab: Tab = {
				id: agentId,
				title: tabData.title,
				messages: chatMessages,
				agentStatus: "idle",
				keyId: tabData.keyId ?? null,
				modelId: tabData.modelId ?? null,
				reasoningEffort: "max",
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
				oldestLoadedSeq: oldestSeqOf(messagesData.messages),
				totalMessages: messagesData.total ?? messagesData.messages.length,
			};
			tabs = [...tabs, newTab];
			activeTabId = agentId;
			evictMessages(agentId);
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
		tabs = tabs.map((t) => (t.id === id ? { ...t, ...patch } : t));
	}

	/**
	 * Record whether a tab's chat view is scrolled up (viewing older history).
	 * Used to suppress automatic eviction while the user is reading old
	 * messages — we don't want to delete what they're currently looking at.
	 */
	function setScrolledUp(tabId: string, scrolledUp: boolean): void {
		if (scrolledUp) scrolledUpTabs.add(tabId);
		else scrolledUpTabs.delete(tabId);
	}

	/**
	 * Trim a tab's in-memory message history down to its `chunkLimit`.
	 *
	 * Counts the total number of chunks across all messages and removes the
	 * oldest messages (from the front of the array) until the count is at or
	 * below the limit — but never drops below a coherent conversation bottom:
	 *   - the in-flight streaming assistant message is always pinned;
	 *   - the most recent user+assistant pair (last 2 messages) is always pinned.
	 *
	 * Evicted messages are fully removed from `tab.messages` — there is no
	 * stub or hidden cache; scrolling up re-fetches them via `loadMoreMessages`.
	 *
	 * Eviction is suppressed while the user is scrolled up (reading history),
	 * unless `force` is true.
	 */
	function evictMessages(tabId: string, force = false): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		if (!force && scrolledUpTabs.has(tabId)) return;

		const limit = appSettings.chunkLimit;
		if (!Number.isFinite(limit) || limit <= 0) return;

		const countChunks = (msgs: ChatMessage[]) => msgs.reduce((sum, m) => sum + m.chunks.length, 0);

		// Work on a shallow copy we can shift from.
		const working = [...tab.messages];
		let total = countChunks(working);
		let removed = false;

		// `chunkLimit` is a SOFT target for trimming OLD history, not a hard
		// cap. We always keep at least the latest user+assistant pair (the
		// `working.length > 2` floor) so the view is never blank and an answer
		// always has its preceding question on screen. Consequently a single
		// very long turn (one message holding e.g. 150 chunks) can briefly push
		// the in-memory total above `limit` — that is intentional and accepted.
		// We never trim chunks from WITHIN a message: messages are the
		// persistence/pagination unit (the backend stores whole rows keyed by
		// `seq` and `loadMoreMessages` pages by whole messages via `?before=`),
		// so a partially-trimmed message would just be re-fetched from the DB
		// and bounce back, and each message's `role` would be lost in a flat
		// chunk array. Whole-message eviction from the front is the correct
		// granularity.
		while (total > limit && working.length > 2) {
			const candidate = working[0];
			if (!candidate) break;
			// Never evict the in-flight streaming assistant message.
			if (candidate.isStreaming || candidate.id === tab.currentAssistantId) break;
			working.shift();
			total -= candidate.chunks.length;
			removed = true;
		}

		if (!removed) return;
		// Recalculate oldestLoadedSeq from remaining messages after eviction so
		// the `?before=` pagination cursor doesn't point at an evicted seq.
		const remainingSeq = (working as Array<ChatMessage & { seq?: number }>).reduce<number | null>(
			(min, m) => (typeof m.seq === "number" && (min === null || m.seq < min) ? m.seq : min),
			null,
		);
		updateTab(tabId, {
			messages: working,
			oldestLoadedSeq: remainingSeq ?? tab.oldestLoadedSeq,
		});
	}

	/**
	 * Fetch and prepend the next page of older messages for a tab. Called when
	 * the user scrolls toward the top. Pages backwards using the oldest loaded
	 * `seq` (`?before=`). Does NOT trigger eviction — the user is reading
	 * history, so we keep everything they've pulled in.
	 */
	async function loadMoreMessages(tabId: string): Promise<void> {
		const tab = getTabById(tabId);
		if (!tab) return;

		const beforeParam = tab.oldestLoadedSeq !== null ? `&before=${tab.oldestLoadedSeq}` : "";
		try {
			const res = await fetch(`${config.apiBase}/tabs/${tabId}/messages?limit=50${beforeParam}`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				messages?: Array<{ id?: string; role: string; chunks?: Chunk[]; seq?: number }>;
				total?: number;
			};
			const rawMessages = data.messages ?? [];
			if (rawMessages.length === 0) {
				// Nothing older to load; record the total if provided.
				if (typeof data.total === "number") {
					updateTab(tabId, { totalMessages: data.total });
				}
				return;
			}

			const older: ChatMessage[] = rawMessages.map((m) => ({
				id: m.id ?? generateId(),
				role: m.role as ChatMessage["role"],
				chunks: Array.isArray(m.chunks) ? m.chunks : [],
				isStreaming: false,
				seq: m.seq,
			}));

			const current = getTabById(tabId);
			if (!current) return;

			// Avoid duplicating messages we already have loaded.
			const existingIds = new Set(current.messages.map((m) => m.id));
			const toPrepend = older.filter((m) => !existingIds.has(m.id));

			const newOldestSeq = oldestSeqOf(rawMessages);
			updateTab(tabId, {
				messages: [...toPrepend, ...current.messages],
				oldestLoadedSeq: newOldestSeq ?? current.oldestLoadedSeq,
				totalMessages: data.total ?? current.totalMessages,
			});
		} catch (err) {
			console.warn("[loadMoreMessages] failed:", err);
		}
	}

	function ensureAssistantMessage(tabId: string): ChatMessage | null {
		const tab = getTabById(tabId);
		if (!tab) return null;

		if (tab.currentAssistantId) {
			const existing = tab.messages.find((m) => m.id === tab.currentAssistantId);
			if (existing) return existing;
		}

		const id = generateId();
		const newMsg: ChatMessage = {
			id,
			role: "assistant",
			chunks: [],
			isStreaming: true,
		};
		updateTab(tabId, {
			currentAssistantId: id,
			messages: [...tab.messages, newMsg],
		});
		evictMessages(tabId);
		return newMsg;
	}

	function updateMessages(tabId: string, updater: (msgs: ChatMessage[]) => ChatMessage[]): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		updateTab(tabId, { messages: updater(tab.messages) });
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
	 * it back through `updateMessages`. The previous use of `structuredClone`
	 * here threw silently and was swallowed by the WS try/catch — left chunks
	 * empty for every streaming turn.
	 */
	function applyChunkEvent(tabId: string, event: AgentEvent): void {
		ensureAssistantMessage(tabId);
		const tab = getTabById(tabId);
		if (!tab) return;
		const currentId = tab.currentAssistantId;
		if (!currentId) return;
		updateMessages(tabId, (msgs) =>
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
	}

	/**
	 * Route a system event when there's no in-flight assistant turn. Wraps
	 * `applySystemEvent` from core, which either appends a `system` chunk to
	 * the most recent `role: "system"` message or creates a new one.
	 */
	function routeSystemEvent(tabId: string, sysEvent: SystemEventLike): void {
		const tab = getTabById(tabId);
		if (!tab) return;
		// We need to mutate the messages array (applySystemEvent does in-place
		// push). Build a shallow-cloned IdentifiedMessage[] view via
		// `$state.snapshot` (safe against Svelte 5 reactive proxies; native
		// `structuredClone` would throw), run the helper, then write it back.
		const view: IdentifiedMessage[] = tab.messages.map((m) => ({
			id: m.id,
			role: m.role,
			chunks: $state.snapshot(m.chunks) as Chunk[],
		}));
		applySystemEvent(view, sysEvent, generateId);

		// Reconcile: rebuild the ChatMessage array from the view, preserving
		// existing message metadata (isStreaming, debugInfo) where IDs match.
		const byId = new Map(tab.messages.map((m) => [m.id, m]));
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
		updateTab(tabId, { messages: rebuilt });
	}

	/**
	 * Reload a tab's messages from the API. Used after a WS reconnect when
	 * we detect the backend finished work while we were disconnected — the
	 * persisted chunks are the source of truth; in-memory state may be
	 * missing events.
	 */
	async function reloadTabMessagesFromApi(tabId: string): Promise<void> {
		try {
			const res = await fetch(`${config.apiBase}/tabs/${tabId}/messages?limit=100`);
			if (!res.ok) return;
			const data = (await res.json()) as {
				messages: Array<{ id?: string; role: string; chunks?: Chunk[]; seq?: number }>;
				total?: number;
			};
			const reloaded: ChatMessage[] = data.messages.map((m) => ({
				id: m.id ?? generateId(),
				role: m.role as ChatMessage["role"],
				chunks: Array.isArray(m.chunks) ? m.chunks : [],
				isStreaming: false,
				seq: m.seq,
			}));
			updateTab(tabId, {
				messages: reloaded,
				currentAssistantId: null,
				oldestLoadedSeq: oldestSeqOf(data.messages),
				totalMessages: data.total ?? reloaded.length,
			});
			evictMessages(tabId);
		} catch (err) {
			console.warn("[reloadTabMessagesFromApi] failed:", err);
		}
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

		// 3. For each tab, fetch its persisted messages in parallel.
		const messageFetches = tabRows.map(async (row) => {
			try {
				const res = await fetch(`${config.apiBase}/tabs/${row.id}/messages?limit=100`);
				if (!res.ok)
					return { id: row.id, messages: [] as ChatMessage[], total: 0, oldestSeq: null };
				const data = (await res.json()) as {
					messages?: Array<{ id?: string; role: string; chunks?: Chunk[]; seq?: number }>;
					total?: number;
				};
				const rawMessages = data.messages ?? [];
				const messages: ChatMessage[] = rawMessages.map((m) => ({
					id: m.id ?? generateId(),
					role: m.role as ChatMessage["role"],
					chunks: Array.isArray(m.chunks) ? m.chunks : [],
					isStreaming: false,
					seq: m.seq,
				}));
				return {
					id: row.id,
					messages,
					total: data.total ?? messages.length,
					oldestSeq: oldestSeqOf(rawMessages),
				};
			} catch {
				return { id: row.id, messages: [] as ChatMessage[], total: 0, oldestSeq: null };
			}
		});

		const messagesByTab = new Map<string, ChatMessage[]>();
		const totalByTab = new Map<string, number>();
		const oldestSeqByTab = new Map<string, number | null>();
		for (const result of await Promise.all(messageFetches)) {
			messagesByTab.set(result.id, result.messages);
			totalByTab.set(result.id, result.total);
			oldestSeqByTab.set(result.id, result.oldestSeq);
		}

		// 4. Build the Tab objects, splicing in the in-flight snapshot for
		//    running tabs.
		const restored: Tab[] = tabRows.map((row) => {
			const snap = statusMap[row.id];
			const messages = messagesByTab.get(row.id) ?? [];
			const agentStatus: Tab["agentStatus"] = snap?.status ?? "idle";

			let currentAssistantId: string | null = null;
			let finalMessages = messages;

			if (agentStatus === "running" && snap?.currentAssistantId) {
				currentAssistantId = snap.currentAssistantId;
				// Find or create the in-flight assistant message. If the DB
				// already has a row with this id (the backend appended on
				// first flush and we picked it up via /tabs/:id/messages),
				// merge the snapshot chunks on top — the snapshot is the
				// live source of truth and may have chunks the DB doesn't.
				// If there's no matching row, append a new in-flight
				// assistant message holding only the snapshot chunks.
				const existingIdx = finalMessages.findIndex((m) => m.id === snap.currentAssistantId);
				if (existingIdx >= 0) {
					finalMessages = finalMessages.map((m, i) =>
						i === existingIdx
							? {
									...m,
									chunks: snap.currentChunks ? [...snap.currentChunks] : m.chunks,
									isStreaming: true,
								}
							: m,
					);
				} else {
					finalMessages = [
						...finalMessages,
						{
							id: snap.currentAssistantId,
							role: "assistant",
							chunks: snap.currentChunks ? [...snap.currentChunks] : [],
							isStreaming: true,
						},
					];
				}
			}

			return {
				id: row.id,
				title: row.title,
				messages: finalMessages,
				agentStatus,
				keyId: row.keyId ?? null,
				modelId: row.modelId ?? null,
				reasoningEffort: "max",
				currentAssistantId,
				tasks: [],
				injectedSkills: [],
				parentTabId: row.parentTabId ?? null,
				persistent: true,
				agentSlug: null,
				agentScope: null,
				agentModels: null,
				workingDirectory: null,
				queuedMessages: [],
				chunkLimit: appSettings.chunkLimit,
				oldestLoadedSeq: oldestSeqByTab.get(row.id) ?? null,
				totalMessages: totalByTab.get(row.id) ?? finalMessages.length,
			};
		});

		tabs = restored;
		// Trim each restored tab down to the chunk limit (user starts at bottom).
		for (const t of restored) {
			evictMessages(t.id);
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
				if (tabId) {
					updateTab(tabId, { agentStatus: event.status });
					if (event.status === "idle" || event.status === "error") {
						updateTab(tabId, { currentAssistantId: null });
						const tab = getTabById(tabId);
						if (tab && !tab.persistent && tabId !== activeTabId) {
							tabs = tabs.filter((t) => t.id !== tabId);
						}
					}
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
					// has already moved on. Pull the persisted chunks so the
					// final answer shows up.
					if (t.agentStatus === "running" && backendStatus !== "running") {
						void reloadTabMessagesFromApi(t.id);
					}

					// Status alignment.
					if (t.agentStatus !== backendStatus) {
						updateTab(t.id, { agentStatus: backendStatus });
					}

					if (backendStatus === "running") {
						// Seed the in-flight assistant message from the snapshot.
						// This handles the "browser just reopened mid-stream"
						// path: the DB only has chunks up to the last
						// flushAssistant call, but the snapshot has the live
						// in-memory currentChunks.
						if (snap?.currentAssistantId) {
							const targetId = snap.currentAssistantId;
							updateTab(t.id, { currentAssistantId: targetId });
							updateMessages(t.id, (msgs) => {
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
									},
								];
							});
						}
					} else if (t.currentAssistantId) {
						// Not running: clear streaming flags.
						updateMessages(t.id, (msgs) =>
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
			case "done": {
				if (!tabId) break;
				const tab5 = getTabById(tabId);
				if (!tab5) break;
				updateMessages(tabId, (msgs) =>
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
					updateMessages(tabId, (msgs) =>
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
						updateMessages(tabId, (msgs) =>
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
					agentModels?: Array<{ key_id: string; model_id: string }> | null;
				};
				// Only add if we don't already have this tab
				if (!getTabById(newTabEvent.id)) {
					const tab: Tab = {
						id: newTabEvent.id,
						title: newTabEvent.title,
						messages: [],
						agentStatus: "running",
						keyId: newTabEvent.keyId ?? null,
						modelId: newTabEvent.modelId ?? null,
						reasoningEffort: "max",
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
						oldestLoadedSeq: null,
						totalMessages: 0,
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
					// Also add as a user chat message if not already present
					const tabAfterQm = getTabById(tabId);
					const existingMsg = tabAfterQm?.messages.find(
						(m) => m.id === `queued-${mqEvent.messageId}` || m.id === mqEvent.messageId,
					);
					if (!existingMsg) {
						const userMsg: ChatMessage = {
							id: `queued-${mqEvent.messageId}`,
							role: "user",
							chunks: [{ type: "text", text: mqEvent.message }],
						};
						updateTab(tabId, { messages: [...(tabAfterQm?.messages ?? []), userMsg] });
					}
				}
				// If alreadyQueued, the optimistic update already put everything in place with the
				// correct `queued-${messageId}` id — nothing more to do.
				break;
			}
			case "message-consumed": {
				if (!tabId) break;
				const mcEvent = event as AgentEvent & { tabId: string; messageIds: string[] };
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
				// Split the current assistant message: finalize it, then insert
				// the consumed user messages after it. Subsequent streaming events
				// will create a NEW assistant message block below.
				const currentAssistantId = mcTab.currentAssistantId;
				updateMessages(tabId, (msgs) => {
					// Extract consumed messages
					const consumed: ChatMessage[] = [];
					const rest: ChatMessage[] = [];
					for (const m of msgs) {
						if (m.id.startsWith("queued-")) {
							const queuedId = m.id.slice(7);
							if (mcEvent.messageIds.includes(queuedId)) {
								consumed.push({ ...m, id: queuedId });
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
					messages: cancelTab.messages.filter(
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
					models: Array<{ key_id: string; model_id: string }>;
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
					models: Array<{ key_id: string; model_id: string }>;
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

	async function sendMessage(text: string): Promise<void> {
		let tab = getActiveTab();
		if (!tab) return;

		// Refresh agent config to pick up any changes made in AgentBuilder
		if (tab.agentSlug && tab.agentScope) {
			await refreshAgentConfig(tab.id);
			tab = getActiveTab();
			if (!tab) return;
		}

		// Fetch content for checked skills and build the message to send
		let messageToSend = text;
		const checkedKeys = Object.entries(appSettings.skillChecks)
			.filter(([, v]) => v)
			.map(([k]) => k);

		if (checkedKeys.length > 0) {
			const skillSections: string[] = [];
			for (const key of checkedKeys) {
				const [scope, ...nameParts] = key.split(":");
				const name = nameParts.join(":");
				if (!scope || !name) continue;
				const content = await fetchSkillContent(scope, name);
				if (content) {
					skillSections.push(`<skill name="${name}">\n${content}\n</skill>`);
				}
			}
			if (skillSections.length > 0) {
				messageToSend = `[The following skills have been activated for this message]\n\n${skillSections.join("\n\n")}\n\n---\n\n${text}`;
			}

			// Track injected skills on the tab
			const newInjected = [...new Set([...tab.injectedSkills, ...checkedKeys])];
			updateTab(tab.id, { injectedSkills: newInjected });

			// Clear all checks
			appSettings.skillChecks = {};
		}

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

		updateTab(tab.id, { messages: [...tab.messages, userMsg] }); // Generate title from first user message
		if (tab.messages.length === 0 || (tab.messages.length === 1 && tab.title === "New Tab")) {
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
					updateMessages(tab.id, (msgs) =>
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
				updateTab(tab.id, { messages: [...(getTabById(tab.id)?.messages ?? []), errMsg] });
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
						updateMessages(tab.id, (msgs) =>
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
				updateMessages(tab.id, (msgs) =>
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
			updateTab(tab.id, { messages: [...(getTabById(tab.id)?.messages ?? []), errMsg] });
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
			models: Array<{ key_id: string; model_id: string }>;
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
				messages: tab.messages.filter(
					(m) => !(m.role === "user" && m.id === `queued-${messageId}`),
				),
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
		const summarizeChunks = (chunks: (typeof tab.messages)[number]["chunks"]) => {
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
			`Messages in store: ${tab.messages.length}`,
			`Queued messages: ${tab.queuedMessages.length}`,
			`Persistent: ${tab.persistent}`,
			`Working directory: ${tab.workingDirectory ?? "default"}`,
			`Reasoning effort: ${tab.reasoningEffort}`,
			`Pending tasks: ${tab.tasks.length}`,
			"",
		];
		const TOOL_RESULT_MAX = 300;

		for (const msg of tab.messages) {
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
		createNewTab,
		switchTab,
		closeTab,
		sendMessage,
		cancelQueuedMessage,
		stopGeneration,
		changeModel,
		setKey,
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
		loadMoreMessages,
		evictMessages,
		setScrolledUp,
	};
}

export const tabStore = createTabStore();
