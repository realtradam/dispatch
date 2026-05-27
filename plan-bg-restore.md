# Plan: Background-running agents + layout restore on browser reopen

> **Audience**: this plan is consumed by two flash subagents running in parallel,
> plus a Gemini review pass. Flash agents are weak and cheap — every code shape,
> import path, function signature, expected behavior, and test assertion is
> spelled out below. Do NOT improvise. Do NOT rename anything. Do NOT touch
> files outside your segment's "Files owned" list.

---

## 1. Spec (the goal)

Three user-visible behaviors:

1. **Browser-close keeps agents alive.** If the user closes the browser
   window / reloads the page / loses the network, any running agent
   continues processing on the backend. No cancellation is triggered.

2. **Layout restore on browser reopen.** When the page next loads, every
   tab that existed at the time the window was closed is restored, in
   the same order, with full message history. Tabs whose agents finished
   while disconnected appear with the completed message. Tabs whose
   agents are still running appear streaming live (the in-flight
   assistant message is reconstructed from the backend's in-memory
   `currentChunks` plus any new deltas).

3. **Explicit tab-close cancels + forgets.** Clicking the X on a tab in
   the sidebar still cancels the running agent (existing behavior) and
   also prevents that tab from being restored next time (existing
   behavior — `DELETE /tabs/:id` already archives the row by setting
   `is_open = 0`).

The only NEW work is in Behavior 2. Behaviors 1 and 3 already work on
the current `dev` branch; the implementation must preserve them.

---

## 2. Current state (verified findings)

The investigation report from explore agent (`task_id ses_19461dcf5ffe4r7wLyAji7Bn5b`) is the canonical
source. Key facts the implementation MUST respect:

### 2.1 Backend
- The `tabs` table has columns `id, title, key_id, model_id, parent_tab_id, status, is_open, position, created_at, updated_at` (`packages/core/src/db/index.ts:77-88`).
- `archiveTab(id)` sets `is_open = 0` — never hard-deletes. Used by `DELETE /tabs/:id`. (`packages/core/src/db/tabs.ts:118-124`).
- `listOpenTabs()` returns rows where `is_open = 1`, ordered by `position` (`packages/core/src/db/tabs.ts:80-86`).
- `agentManager.tabAgents` is the in-memory `Map<string, TabAgent>` where each TabAgent tracks `agent`, `status`, `currentChunks: Chunk[] | null`, `currentAssistantId: string | null`, `messageQueue: QueuedMessage[]` (`packages/api/src/agent-manager.ts:137-177`).
- `getAllStatuses()` currently returns `Record<string, AgentStatus>` — just the strings (`packages/api/src/agent-manager.ts:714-720`).
- `processMessage` is fire-and-forget: `app.ts:77-79` calls `.processMessage(...).catch(console.error)` and returns immediately.
- WS `onClose` does NOT stop agents — it only unsubscribes the per-client event listener (`packages/api/src/index.ts:58-66`).
- `flushAssistant` (the per-turn DB write) is only called at turn-end (`done`) or on system events — NOT on every delta. Mid-stream chunks live in memory only.

### 2.2 Frontend
- `App.svelte:onMount` currently does: `wsClient.connect()` → `fetchModels()` → `if (tabStore.tabs.length === 0) tabStore.createNewTab()`. **It never reads existing backend tabs.** Every page load is a clean slate.
- Tab state lives only in Svelte `$state` — zero `localStorage` / `IndexedDB` persistence of tab ids.
- The existing `statuses` WS event handler (`tabs.svelte.ts:419-446`) reconciles status drift but only for tabs the frontend already has in `$state`. Tabs the frontend doesn't know about are silently ignored.

### 2.3 The wire shapes (the flash agents MUST match these exactly)
- `GET /tabs` → `{ tabs: TabRow[] }` where each `TabRow = { id, title, keyId, modelId, parentTabId, status, isOpen, position, createdAt, updatedAt }`. **Note camelCase** — the DB function `listOpenTabs` translates snake_case to camelCase.
- `GET /tabs/:id/messages` → `{ messages: Array<{ id, role, chunks, ... }> }`.
- `GET /status` → `{ status, messageCount, statuses }`. The `statuses` field's shape is being changed in this plan.
- `DELETE /tabs/:id` → `{ success: true }`. Already cancels + archives. Unchanged.
- `POST /tabs` body `{ id?: string; title?: string }` → returns the new tab. Unchanged.

---

## 3. Design

### 3.1 Strategy

The backend already runs agents independently of WS subscribers (Behavior 1
works for free). The persistent record (DB) already survives across browser
sessions (Behavior 2's data is already on disk). The X-button already
cancels and archives (Behavior 3 works for free).

So the entire feature reduces to: **on browser reopen, the frontend must
fetch the persisted tabs and rebuild the UI state, and for any tab that's
still streaming it must pick up the live event flow without losing the
chunks that were emitted before the WS handshake completed.**

### 3.2 The mid-stream catch-up problem

If a tab is `running` at the moment the new browser session connects, the
DB has chunks from the most recent `flushAssistant` call (turn-end or
system event), NOT the live in-memory `currentChunks` array. The frontend
needs that in-memory array to render the streaming assistant message
correctly.

**Solution**: enrich the existing `statuses` snapshot (sent over both
`GET /status` HTTP and the WS `onOpen`) to include `currentChunks` and
`currentAssistantId` for every running tab. The frontend uses this
snapshot to seed the in-flight assistant message before live deltas
arrive. The race is safe because:

1. JS is single-threaded — reading `currentChunks` and serializing it in
   the WS `onOpen` handler is atomic with respect to other event-loop
   ticks.
2. The frontend treats the snapshot as authoritative initial state for
   the in-flight assistant message; subsequent live deltas append on top
   via the existing `applyChunkEvent` path.

### 3.3 What's NOT in scope

- Per-delta DB flushing (not needed — snapshot covers in-flight state).
- Persisting queued messages across server restart (server restart kills
  the in-memory agent anyway; queued messages were always best-effort).
- Subagent (`parentTabId != null`) ordering changes — they restore the
  same way as user tabs; the existing `TabBar.svelte` already separates
  parent vs child rows.
- LocalStorage cache of tabs (the backend DB is the source of truth).
- Migrating any DB schema (the existing schema already supports
  everything we need via `is_open`).

---

## 4. Phase plan

```
Phase 0 (sequential, I do it)
   ├─ Add shared `TabStatusSnapshot` type in packages/core/src/types/index.ts
   ├─ Re-export from packages/core/src/index.ts
   └─ Verify core typecheck + biome

Phase 1 (parallel, two flash agents)
   ├─ Segment A: Backend           — flash agent A
   │   ├─ packages/api/src/agent-manager.ts
   │   └─ packages/api/tests/agent-manager.test.ts
   │
   └─ Segment B: Frontend          — flash agent B
       ├─ packages/frontend/src/lib/types.ts          (mirror type)
       ├─ packages/frontend/src/lib/tabs.svelte.ts    (hydrateFromBackend + statuses handler update)
       ├─ packages/frontend/src/App.svelte            (onMount sequencing)
       └─ packages/frontend/tests/chat-store.test.ts

Phase 2 (sequential, I do it)
   ├─ Run typecheck on all three packages
   ├─ Run tests on all three packages
   ├─ Run biome
   └─ Sanity-check the integration manually

Phase 3 (I do it)
   ├─ Launch gemini subagent for read-only review (writes report.md only)
   ├─ Do my own review in parallel
   └─ WAIT for gemini to finish before applying any fixes

Phase 4 (I do it, possibly spawning more flash agents)
   └─ Apply fixes from gemini + self-review
```

---

## 5. Phase 0 — Shared type (main agent only)

### 5.1 File: `packages/core/src/types/index.ts`

Add the following ABOVE the existing `AgentEvent` discriminated union (i.e.
in the "Agent Status & Events" section, immediately after `AgentStatus`
type definition):

```ts
/**
 * Snapshot of a single tab's live state, sent on WS connect and via
 * `GET /status`. Carries enough information for a freshly-loaded
 * frontend to reconstruct any in-flight assistant message.
 *
 * - `status` — always present; mirrors the in-memory `TabAgent.status`.
 * - `currentChunks` — the live in-flight `Chunk[]` for the running
 *   assistant turn. Present iff `status === "running"` AND
 *   `TabAgent.currentChunks` is non-null. Defensively copied at
 *   snapshot time; the consumer owns the array.
 * - `currentAssistantId` — DB id of the in-flight assistant message
 *   (the row that the eventual `flushAssistant` call will write/update).
 *   Present iff `status === "running"` AND `TabAgent.currentAssistantId`
 *   is set. The frontend uses this to align its local assistant message
 *   id with the persisted id so subsequent `done` / reload paths line up.
 */
export interface TabStatusSnapshot {
	status: AgentStatus;
	currentChunks?: Chunk[];
	currentAssistantId?: string;
}
```

Then UPDATE the existing `statuses` variant of `AgentEvent` (currently around line 134, but verify with grep on `"statuses"` literal) to use the new shape:

```ts
// before:
//   | { type: "statuses"; statuses: Record<string, AgentStatus> }
// after:
	| { type: "statuses"; statuses: Record<string, TabStatusSnapshot> }
```

### 5.2 File: `packages/core/src/index.ts`

If `TabStatusSnapshot` is not already re-exported via a `export * from "./types"` (it almost certainly already is — verify by reading the file), no change needed. Otherwise add it to the explicit type re-export list.

### 5.3 Verification

```sh
bun run --cwd packages/core typecheck
bun run --cwd packages/core test
bunx biome check packages/core
```

All three must be clean. If they're not, fix the type issue before
proceeding to Phase 1.

---

## 6. Phase 1 — Parallel implementation

> **CRITICAL FOR FLASH AGENTS**: read your segment in full BEFORE touching
> any file. Every file path, function signature, and code block is exact.
> Do not improvise. If something is ambiguous, leave a `TODO(plan-bg-restore):`
> comment instead of guessing.

### 6.A SEGMENT A — Backend

**Files owned (exclusive write access):**
- `packages/api/src/agent-manager.ts`
- `packages/api/tests/agent-manager.test.ts`

**Files allowed to READ (do not modify):**
- `packages/core/src/types/index.ts` (already has `TabStatusSnapshot` from Phase 0)
- `packages/api/src/app.ts` (already calls `agentManager.getAllStatuses()` — its consumption pattern shows the contract)
- `packages/api/src/index.ts` (already calls `agentManager.getAllStatuses()` in the WS `onOpen` — same contract)

#### Task A.1 — Add the snapshot import

At the top of `packages/api/src/agent-manager.ts`, locate the existing import block from `@dispatch/core`. Add `TabStatusSnapshot` to that type-import list. Example:

```ts
// Before (illustrative; merge with the existing import in place):
import type { AgentEvent, AgentStatus, Chunk, ChatMessage } from "@dispatch/core";

// After:
import type { AgentEvent, AgentStatus, Chunk, ChatMessage, TabStatusSnapshot } from "@dispatch/core";
```

#### Task A.2 — Rewrite `getAllStatuses`

Find the existing method at `packages/api/src/agent-manager.ts:714-720`. It currently reads:

```ts
getAllStatuses(): Record<string, AgentStatus> {
	const result: Record<string, AgentStatus> = {};
	for (const [tabId, tabAgent] of this.tabAgents.entries()) {
		result[tabId] = tabAgent.status;
	}
	return result;
}
```

Replace with:

```ts
/**
 * Snapshot of every tab the manager is currently tracking. Sent on WS
 * connect and via GET /status so a freshly-loaded frontend can
 * reconstruct any in-flight assistant turn without missing the chunks
 * that arrived before its WS handshake completed.
 *
 * For each running tab, the snapshot includes:
 *   - status: "running"
 *   - currentChunks: a defensive shallow copy of `tabAgent.currentChunks`
 *     (the live chunk array the streaming loop appends to). The
 *     consumer owns this copy and may mutate it freely.
 *   - currentAssistantId: the DB id of the in-flight assistant message
 *     row. The frontend aligns its local assistant message id with
 *     this so the next `done` event lands on the right message.
 *
 * For idle/error tabs, only `status` is present. Tabs not in
 * `this.tabAgents` (e.g. tabs in the DB that have never been touched
 * since server start) are absent from the returned record — the
 * caller infers their status from the DB row (always "idle" at rest).
 */
getAllStatuses(): Record<string, TabStatusSnapshot> {
	const result: Record<string, TabStatusSnapshot> = {};
	for (const [tabId, tabAgent] of this.tabAgents.entries()) {
		const snap: TabStatusSnapshot = { status: tabAgent.status };
		if (tabAgent.status === "running") {
			if (tabAgent.currentChunks) {
				// Defensive shallow copy: callers may serialize/mutate.
				snap.currentChunks = [...tabAgent.currentChunks];
			}
			if (tabAgent.currentAssistantId) {
				snap.currentAssistantId = tabAgent.currentAssistantId;
			}
		}
		result[tabId] = snap;
	}
	return result;
}
```

**DO NOT** add a separate `getTabSnapshot(tabId)` method. The single
`getAllStatuses` covers every consumer.

#### Task A.3 — Tests

In `packages/api/tests/agent-manager.test.ts`, add a new `describe` block at the end of the existing top-level `describe("AgentManager", ...)`. Place it as the LAST sub-section, AFTER the existing "done event includes a thinking chunk with metadata in its message" test and AFTER the "History pre-population on Agent (re)construction" tests already in place. Use this exact code:

```ts
	// ─── getAllStatuses snapshot shape (for browser-reopen restore) ────
	//
	// The snapshot enriches the legacy `Record<string, AgentStatus>` shape
	// with per-tab in-flight context so a fresh frontend can render the
	// streaming assistant message correctly after a reload.

	it("getAllStatuses returns an empty record when no tabs are tracked", () => {
		const manager = new AgentManager();
		expect(manager.getAllStatuses()).toEqual({});
	});

	it("getAllStatuses returns { status } for an idle tab (no currentChunks/currentAssistantId)", async () => {
		const manager = new AgentManager();
		// Drive a full turn so the tab gets registered; default mock run
		// settles back to idle by the time `await` resolves.
		await manager.processMessage("tab-idle", "hi");
		const snap = manager.getAllStatuses();
		expect(snap["tab-idle"]).toBeDefined();
		expect(snap["tab-idle"]?.status).toBe("idle");
		expect(snap["tab-idle"]).not.toHaveProperty("currentChunks");
		expect(snap["tab-idle"]).not.toHaveProperty("currentAssistantId");
	});

	it("getAllStatuses includes currentChunks and currentAssistantId for a running tab", () => {
		const manager = new AgentManager();
		// Reach into the private map to set up a synthetic running state.
		// Justification: there is no public API to enter a sustained
		// "running" state without actually streaming, and we want to
		// assert the snapshot shape — not the streaming pipeline.
		const inner = manager as unknown as {
			tabAgents: Map<string, {
				agent: null;
				status: "running" | "idle" | "error";
				keyId: null;
				modelId: null;
				taskList: { onChange: (cb: unknown) => void };
				messageQueue: unknown[];
				queueListeners: unknown[];
				shellStore: unknown;
				transcriptStore: unknown;
				currentChunks: Array<{ type: string; text?: string }> | null;
				currentAssistantId: string | null;
			}>;
		};
		inner.tabAgents.set("tab-running", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: [
				{ type: "thinking", text: "let me think" },
				{ type: "text", text: "partial answer" },
			],
			currentAssistantId: "assistant-msg-id-7",
		});

		const snap = manager.getAllStatuses();
		expect(snap["tab-running"]).toBeDefined();
		expect(snap["tab-running"]?.status).toBe("running");
		expect(snap["tab-running"]?.currentAssistantId).toBe("assistant-msg-id-7");
		expect(snap["tab-running"]?.currentChunks).toEqual([
			{ type: "thinking", text: "let me think" },
			{ type: "text", text: "partial answer" },
		]);
	});

	it("getAllStatuses defensively copies currentChunks (mutating the snapshot doesn't affect the live array)", () => {
		const manager = new AgentManager();
		const inner = manager as unknown as {
			tabAgents: Map<string, {
				agent: null;
				status: "running";
				keyId: null;
				modelId: null;
				taskList: { onChange: (cb: unknown) => void };
				messageQueue: unknown[];
				queueListeners: unknown[];
				shellStore: unknown;
				transcriptStore: unknown;
				currentChunks: Array<{ type: string; text?: string }>;
				currentAssistantId: string;
			}>;
		};
		const liveChunks = [{ type: "text", text: "live" }];
		inner.tabAgents.set("tab-copy", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: liveChunks,
			currentAssistantId: "msg-x",
		});

		const snap = manager.getAllStatuses();
		// Mutate the snapshot's array
		snap["tab-copy"]?.currentChunks?.push({ type: "text", text: "polluted" });
		// Live array must be untouched
		expect(liveChunks).toEqual([{ type: "text", text: "live" }]);
	});

	it("getAllStatuses omits currentChunks when a running tab has none yet", () => {
		const manager = new AgentManager();
		const inner = manager as unknown as {
			tabAgents: Map<string, {
				agent: null;
				status: "running";
				keyId: null;
				modelId: null;
				taskList: { onChange: (cb: unknown) => void };
				messageQueue: unknown[];
				queueListeners: unknown[];
				shellStore: unknown;
				transcriptStore: unknown;
				currentChunks: null;
				currentAssistantId: null;
			}>;
		};
		inner.tabAgents.set("tab-early", {
			agent: null,
			status: "running",
			keyId: null,
			modelId: null,
			taskList: { onChange: () => {} },
			messageQueue: [],
			queueListeners: [],
			shellStore: {},
			transcriptStore: {},
			currentChunks: null,
			currentAssistantId: null,
		});

		const snap = manager.getAllStatuses();
		expect(snap["tab-early"]?.status).toBe("running");
		expect(snap["tab-early"]).not.toHaveProperty("currentChunks");
		expect(snap["tab-early"]).not.toHaveProperty("currentAssistantId");
	});
```

#### Task A.4 — Verify

```sh
bun run --cwd packages/api typecheck    # must pass
bun run --cwd packages/api test         # all tests must pass (existing + new)
bunx biome check packages/api           # must be clean (no errors)
```

If biome reports formatting issues, run `bunx biome check --write packages/api` and re-verify.

#### Task A.5 — What NOT to do

- **DO NOT** modify `packages/api/src/index.ts`. The WS `onOpen` already calls `agentManager.getAllStatuses()` — the wire payload changes automatically when the return type changes.
- **DO NOT** modify `packages/api/src/app.ts`. The `GET /status` route already calls `agentManager.getAllStatuses()` — same automatic propagation.
- **DO NOT** modify the frontend. Segment B owns it.
- **DO NOT** change any existing test cases. Only add the new ones described above.
- **DO NOT** add or change the `getStatus()` (singular, deprecated) method. Leave it as-is.
- **DO NOT** add or change `getTabStatus(tabId)`. Leave it returning `AgentStatus`.

---

### 6.B SEGMENT B — Frontend

**Files owned (exclusive write access):**
- `packages/frontend/src/lib/types.ts`
- `packages/frontend/src/lib/tabs.svelte.ts`
- `packages/frontend/src/App.svelte`
- `packages/frontend/tests/chat-store.test.ts`

**Files allowed to READ (do not modify):**
- `packages/core/src/types/index.ts` (already has `TabStatusSnapshot` from Phase 0; you'll mirror the type)
- `packages/frontend/src/lib/config.ts` (gives you `config.apiBase`)
- `packages/frontend/src/lib/ws.svelte.ts` (gives you `wsClient.connect()`)

#### Task B.1 — Mirror the `TabStatusSnapshot` type in the frontend

The frontend deliberately mirrors core's type shapes locally (see the existing `Chunk` and `AgentEvent` types in `packages/frontend/src/lib/types.ts:21-127`). Add the snapshot type next to those.

In `packages/frontend/src/lib/types.ts`, find the existing `AgentEvent` discriminated union (currently at line 79). The `statuses` variant currently reads:

```ts
| { type: "statuses"; statuses: Record<string, "idle" | "running" | "error"> }
```

Replace this single variant with:

```ts
| { type: "statuses"; statuses: Record<string, TabStatusSnapshot> }
```

Then add the `TabStatusSnapshot` interface immediately before the `AgentEvent` union (i.e. between the existing `ConnectionStatus` type and the `AgentEvent` union):

```ts
/**
 * Mirror of core's `TabStatusSnapshot` (see packages/core/src/types/index.ts).
 *
 * Sent on every WS (re)connect and via `GET /status`. The frontend uses
 * this to:
 *   - reconcile its in-memory `agentStatus` with the backend's truth
 *     after a disconnect window;
 *   - reconstruct the in-flight assistant message for any tab the
 *     backend is currently streaming, so the user sees the partial
 *     thinking / text without waiting for the next delta.
 *
 * Wire-format symmetry MUST be kept with core. If you change one,
 * change the other.
 */
export interface TabStatusSnapshot {
	status: "idle" | "running" | "error";
	currentChunks?: Chunk[];
	currentAssistantId?: string;
}
```

#### Task B.2 — Add `hydrateFromBackend()` to the tab store

In `packages/frontend/src/lib/tabs.svelte.ts`, add a new function `hydrateFromBackend()` and export it from the store. Place the function definition adjacent to the existing `openAgentTab` and `reloadTabMessagesFromApi` (around line 172-400 of the file).

The function should be defined inside the `createTabStore` factory (or wherever the existing exported functions like `createNewTab`, `closeTab` live). It should be exported by adding it to the returned object literal at the bottom of `createTabStore`.

Exact behavior (see also Task B.3 and B.4 for the integration):

```ts
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
			const res = await fetch(`${config.apiBase}/tabs/${row.id}/messages`);
			if (!res.ok) return { id: row.id, messages: [] as ChatMessage[] };
			const data = (await res.json()) as {
				messages?: Array<{ id?: string; role: string; chunks?: Chunk[] }>;
			};
			const messages: ChatMessage[] = (data.messages ?? []).map((m) => ({
				id: m.id ?? generateId(),
				role: m.role as ChatMessage["role"],
				chunks: Array.isArray(m.chunks) ? m.chunks : [],
				isStreaming: false,
			}));
			return { id: row.id, messages };
		} catch {
			return { id: row.id, messages: [] as ChatMessage[] };
		}
	});

	const messagesByTab = new Map<string, ChatMessage[]>();
	for (const result of await Promise.all(messageFetches)) {
		messagesByTab.set(result.id, result.messages);
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
		};
	});

	tabs = restored;
	// Activate the first restored tab (the list is already ordered by
	// `position` from the backend).
	activeTabId = restored[0]?.id ?? null;
	return restored.length;
}
```

Then add `hydrateFromBackend` to the returned object at the bottom of `createTabStore` so it's accessible via `tabStore.hydrateFromBackend()`. Find the existing `return { ... }` block (it lists `createNewTab`, `switchTab`, `closeTab`, etc.) and add `hydrateFromBackend,` to it. **DO NOT** reorder existing keys.

#### Task B.3 — Update the WS `statuses` handler

In `packages/frontend/src/lib/tabs.svelte.ts`, find the existing `case "statuses":` block inside `handleEvent` (currently around line 419-446). It currently reads:

```ts
case "statuses": {
	const backend = event.statuses;
	for (const t of tabs) {
		const backendStatus = backend[t.id] ?? "idle";
		if (t.agentStatus === "running" && backendStatus !== "running") {
			void reloadTabMessagesFromApi(t.id);
		}
		if (t.agentStatus !== backendStatus) {
			updateTab(t.id, { agentStatus: backendStatus });
		}
		if (backendStatus !== "running" && t.currentAssistantId) {
			updateMessages(t.id, (msgs) =>
				msgs.map((m) => (m.id === t.currentAssistantId ? { ...m, isStreaming: false } : m)),
			);
			updateTab(t.id, { currentAssistantId: null });
		}
	}
	break;
}
```

Replace this entire `case "statuses":` block with the following:

```ts
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
				msgs.map((m) =>
					m.id === t.currentAssistantId ? { ...m, isStreaming: false } : m,
				),
			);
			updateTab(t.id, { currentAssistantId: null });
		}
	}
	break;
}
```

**DO NOT** modify any other case in the `handleEvent` switch.

#### Task B.4 — Update `App.svelte` onMount to hydrate

In `packages/frontend/src/App.svelte`, find the existing `onMount` (currently lines 78-99). It reads:

```ts
onMount(() => {
	// Apply saved theme
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) {
		document.documentElement.setAttribute("data-theme", saved);
	}

	// Connect WebSocket
	wsClient.connect();

	// Initial models fetch
	fetchModels();

	// Create initial tab
	if (tabStore.tabs.length === 0) {
		tabStore.createNewTab();
	}

	return () => {
		wsClient.disconnect();
	};
});
```

Replace its body so it (1) hydrates tabs from the backend BEFORE deciding to create a fresh tab, and (2) connects the WS in parallel with hydration (since hydration uses HTTP, the WS connect can race ahead — the WS `statuses` handler is now idempotent for already-restored tabs):

```ts
onMount(() => {
	// Apply saved theme
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved) {
		document.documentElement.setAttribute("data-theme", saved);
	}

	// Connect WebSocket in parallel with hydration. The `statuses`
	// snapshot delivered on WS open is idempotent against
	// already-hydrated tabs (the handler reconciles per-tab).
	wsClient.connect();

	// Initial models fetch (fire-and-forget; UI tolerates models
	// arriving later than tabs).
	fetchModels();

	// Restore tabs from the backend. The user's previous session is
	// the source of truth; only fall back to a fresh tab if nothing
	// was restored (first-ever load, or DB was wiped, or HTTP failed).
	void (async () => {
		const restored = await tabStore.hydrateFromBackend();
		if (restored === 0 && tabStore.tabs.length === 0) {
			await tabStore.createNewTab();
		}
	})();

	return () => {
		wsClient.disconnect();
	};
});
```

**DO NOT** change the `<script>` imports unless the `void (async () => { ... })()` pattern triggers a lint warning — in which case wrap in a named async function expression instead.

#### Task B.5 — Tests

In `packages/frontend/tests/chat-store.test.ts`, append a new `describe` block at the very end of the file (after the existing tests' closing brace).

The test fixture pattern in this file already mocks `fetch`. You will override the mock per-test using `vi.stubGlobal("fetch", ...)`.

Add the following tests (with their imports merged into the existing top-of-file import block as needed):

```ts
// ─── hydrateFromBackend ─────────────────────────────────────────
//
// Verifies the browser-reopen restore path: GET /tabs + GET /status +
// GET /tabs/:id/messages combined into the in-memory tab store with
// in-flight chunks seeded for any running tab.

describe("hydrateFromBackend", () => {
	it("restores tabs from /tabs with their persisted messages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{ id: "t1", title: "First", keyId: null, modelId: null, parentTabId: null },
									{ id: "t2", title: "Second", keyId: "k", modelId: "m", parentTabId: null },
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ statuses: {} }),
					});
				}
				if (url.endsWith("/tabs/t1/messages")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								messages: [
									{ id: "m1", role: "user", chunks: [{ type: "text", text: "hello" }] },
									{
										id: "m2",
										role: "assistant",
										chunks: [{ type: "text", text: "hi back" }],
									},
								],
							}),
					});
				}
				if (url.endsWith("/tabs/t2/messages")) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ messages: [] }),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(2);
		expect(store.tabs.length).toBe(2);
		expect(store.tabs[0]?.id).toBe("t1");
		expect(store.tabs[0]?.messages.length).toBe(2);
		expect(store.tabs[1]?.id).toBe("t2");
		expect(store.tabs[1]?.messages.length).toBe(0);
		expect(store.activeTabId).toBe("t1");
	});

	it("seeds the in-flight assistant message from /status for a running tab", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [
									{ id: "tr", title: "Running tab", keyId: null, modelId: null, parentTabId: null },
								],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								statuses: {
									tr: {
										status: "running",
										currentAssistantId: "live-msg-id",
										currentChunks: [
											{ type: "thinking", text: "still thinking" },
											{ type: "text", text: "partial " },
										],
									},
								},
							}),
					});
				}
				if (url.endsWith("/tabs/tr/messages")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								messages: [{ id: "u1", role: "user", chunks: [{ type: "text", text: "go" }] }],
							}),
					});
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);

		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(1);
		const tab = store.tabs[0];
		expect(tab?.agentStatus).toBe("running");
		expect(tab?.currentAssistantId).toBe("live-msg-id");
		// Two messages: the user message + the seeded in-flight assistant.
		expect(tab?.messages.length).toBe(2);
		const inflight = tab?.messages.find((m) => m.id === "live-msg-id");
		expect(inflight).toBeDefined();
		expect(inflight?.isStreaming).toBe(true);
		expect(inflight?.chunks).toEqual([
			{ type: "thinking", text: "still thinking" },
			{ type: "text", text: "partial " },
		]);
	});

	it("returns 0 and leaves tabs empty when /tabs fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(0);
	});

	it("returns 0 and leaves tabs empty when /tabs returns an empty array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ tabs: [] }) });
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(0);
	});

	it("is a no-op when the store already has tabs (idempotency)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("should not be called"))),
		);
		const store = createTabStore();
		// Pretend the store already has a tab (e.g. from a hot-reload).
		// We do this by reaching into the store via the public API.
		// Use the create path with mocked fetch failure (existing
		// `createNewTab` already tolerates fetch failure — adds locally).
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(new Error("test: createNewTab fetch reject"))),
		);
		await store.createNewTab();
		expect(store.tabs.length).toBe(1);

		// Now swap to a fetch that would lie about there being 3 tabs;
		// hydrateFromBackend must NOT call it.
		const sentinelFetch = vi.fn(() =>
			Promise.resolve({
				ok: true,
				json: () => Promise.resolve({ tabs: [{ id: "x" }, { id: "y" }, { id: "z" }] }),
			}),
		);
		vi.stubGlobal("fetch", sentinelFetch);
		const n = await store.hydrateFromBackend();
		expect(n).toBe(0);
		expect(store.tabs.length).toBe(1);
		expect(sentinelFetch).not.toHaveBeenCalled();
	});

	it("restores a tab with an idle status when /status omits it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.endsWith("/tabs")) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								tabs: [{ id: "ti", title: "Idle", keyId: null, modelId: null, parentTabId: null }],
							}),
					});
				}
				if (url.endsWith("/status")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ statuses: {} }) });
				}
				if (url.endsWith("/tabs/ti/messages")) {
					return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [] }) });
				}
				return Promise.reject(new Error(`unexpected fetch ${url}`));
			}),
		);
		const store = createTabStore();
		const n = await store.hydrateFromBackend();
		expect(n).toBe(1);
		expect(store.tabs[0]?.agentStatus).toBe("idle");
		expect(store.tabs[0]?.currentAssistantId).toBeNull();
	});
});

// ─── statuses WS event with the wider TabStatusSnapshot shape ───
//
// The handler must reconcile snapshot.status against the local tab,
// and (when running) seed currentChunks into the in-flight assistant
// message.

describe("handleEvent statuses with TabStatusSnapshot", () => {
	it("seeds the in-flight assistant message when a running snapshot arrives", () => {
		const store = createTabStore();
		// Manually add a tab to the store via the existing createNewTab path
		// (fetch was mocked to reject in beforeEach; createNewTab tolerates).
		// We then drive a statuses event.
		void store.createNewTab();
		const tabId = store.tabs[0]?.id;
		if (!tabId) throw new Error("test fixture: tab id missing");

		store.handleEvent({
			type: "statuses",
			statuses: {
				[tabId]: {
					status: "running",
					currentAssistantId: "live-x",
					currentChunks: [{ type: "text", text: "live data" }],
				},
			},
		});

		const tab = store.tabs.find((t) => t.id === tabId);
		expect(tab?.agentStatus).toBe("running");
		expect(tab?.currentAssistantId).toBe("live-x");
		const inflight = tab?.messages.find((m) => m.id === "live-x");
		expect(inflight).toBeDefined();
		expect(inflight?.chunks).toEqual([{ type: "text", text: "live data" }]);
		expect(inflight?.isStreaming).toBe(true);
	});

	it("clears in-flight pointers when snapshot says the tab is idle", () => {
		const store = createTabStore();
		void store.createNewTab();
		const tabId = store.tabs[0]?.id;
		if (!tabId) throw new Error("test fixture: tab id missing");

		// First put the tab into a running state with an in-flight message.
		store.handleEvent({
			type: "statuses",
			statuses: {
				[tabId]: {
					status: "running",
					currentAssistantId: "msg-a",
					currentChunks: [{ type: "text", text: "x" }],
				},
			},
		});
		expect(store.tabs.find((t) => t.id === tabId)?.currentAssistantId).toBe("msg-a");

		// Now snapshot says idle.
		store.handleEvent({
			type: "statuses",
			statuses: { [tabId]: { status: "idle" } },
		});
		const tab = store.tabs.find((t) => t.id === tabId);
		expect(tab?.agentStatus).toBe("idle");
		expect(tab?.currentAssistantId).toBeNull();
		const msgA = tab?.messages.find((m) => m.id === "msg-a");
		expect(msgA?.isStreaming).toBe(false);
	});
});
```

You may need to import `createTabStore` and the `TabStatusSnapshot` type — check the existing imports at the top of the test file. The store factory and types should already be importable from the locations the existing tests use.

#### Task B.6 — Verify

```sh
bun run --cwd packages/frontend typecheck   # svelte-check, must pass
bun run --cwd packages/frontend test        # all tests must pass
bunx biome check packages/frontend          # must be clean
```

If biome reports formatting issues, run `bunx biome check --write packages/frontend` and re-verify.

#### Task B.7 — What NOT to do

- **DO NOT** modify any backend file. Segment A owns those.
- **DO NOT** rename, delete, or reorder any existing exported functions on the tab store.
- **DO NOT** modify `createNewTab`, `closeTab`, `openAgentTab`, `reloadTabMessagesFromApi`, or any other existing function. Only ADD `hydrateFromBackend` and CHANGE the body of the `case "statuses":` block in `handleEvent`.
- **DO NOT** touch the WebSocket lifecycle (`wsClient.connect` / `disconnect`). The `App.svelte` change is the only WS-related edit.
- **DO NOT** add a `beforeunload` handler or any "I'm leaving" signal. The whole point of Behavior 1 is that the agent keeps running silently.
- **DO NOT** change `tabs.svelte.ts:openAgentTab` even if it looks similar to `hydrateFromBackend`. They serve different purposes (single-tab opening vs full restore).
- **DO NOT** add localStorage persistence of tab ids. The backend DB is the source of truth.

---

## 7. Phase 2 — Integration check (main agent)

After both flash agents report success, the main agent runs:

```sh
# from /home/tradam/projects/dispatch
bun run --cwd packages/core typecheck
bun run --cwd packages/core test
bun run --cwd packages/api typecheck
bun run --cwd packages/api test
bun run --cwd packages/frontend typecheck
bun run --cwd packages/frontend test
bun run check                  # root-level biome
```

All seven commands must be green. If any fail, classify the failure:
- **Type drift across the segment boundary** (e.g. shape of `TabStatusSnapshot` differs between core mirror and frontend mirror) → fix in Phase 4 with a targeted edit.
- **Test failure inside a single segment** → flash agent missed a case; re-launch that segment's flash agent with the failure log.
- **Test failure crossing segments** → main agent fixes directly.

Also do a manual smoke read:
- Open `packages/api/src/agent-manager.ts:714` and confirm `getAllStatuses` returns `Record<string, TabStatusSnapshot>`.
- Open `packages/frontend/src/lib/tabs.svelte.ts` and confirm `hydrateFromBackend` exists, is exported, and is called from `App.svelte:onMount`.
- Open `packages/frontend/src/App.svelte` and confirm the onMount await-and-fallback pattern.

---

## 8. Phase 3 — Review

### 8.1 Launch Gemini (read-only)

Spawn the `gemini` subagent with this prompt:

> Review the implementation of the "background agents + layout restore" feature against the spec in `plan-bg-restore.md`. Read every file referenced in Phase 1 (Segment A files and Segment B files). Verify:
>
> 1. `getAllStatuses` in `packages/api/src/agent-manager.ts` matches Task A.2 exactly — including the defensive shallow copy of `currentChunks` and the conditional omission for non-running tabs.
> 2. The frontend `TabStatusSnapshot` mirror in `packages/frontend/src/lib/types.ts` is structurally identical to the core type.
> 3. `hydrateFromBackend` in `packages/frontend/src/lib/tabs.svelte.ts` correctly handles every failure mode listed in Task B.2 (no fatal throws, partial-failure tolerance, idempotency guard).
> 4. The WS `statuses` handler in `tabs.svelte.ts` correctly seeds in-flight chunks for running tabs and clears streaming pointers for idle/error tabs, without regressing the existing desync recovery path (`reloadTabMessagesFromApi` should still fire when frontend thinks running but backend says idle).
> 5. `App.svelte:onMount` calls `hydrateFromBackend` before falling back to `createNewTab`, AND only creates a fresh tab when `restored === 0 && tabStore.tabs.length === 0`.
> 6. Tests cover: empty DB; partial failure of `/tabs/:id/messages`; in-flight snapshot seeding; idempotency when tabs already exist; clearing in-flight pointers on idle snapshot.
> 7. Behavior 1 (browser close ≠ agent stop) is preserved — verify no new `beforeunload`, `unload`, or WS-close-triggered `stopTab` calls were introduced.
> 8. Behavior 3 (X-close cancels + archives) is preserved — verify `closeTab` in `tabs.svelte.ts` still calls `DELETE /tabs/:id` and that the backend `DELETE /tabs/:id` route still calls both `agentManager.deleteTab` and `archiveTab`.
>
> Write your findings to `report.md` in the repo root. DO NOT modify any source file. Categorize each finding as Block / Ship-with-followup / Nit. Quote `file_path:line_number` for every finding.

### 8.2 Self-review (in parallel with gemini)

While gemini runs, the main agent independently reviews the same files
against the spec. Note any issues to compare against gemini's output.

### 8.3 Wait for gemini

**Hard requirement**: do NOT apply any fixes until gemini's report.md
exists and has been read. The user explicitly asked for this gate.

---

## 9. Phase 4 — Apply fixes

### 9.1 Combine findings

Merge self-review + gemini findings into a single deduplicated list,
classified Block / Ship-with-followup / Nit. Resolve disagreements by
re-reading the relevant code; default to following the spec.

### 9.2 Apply

- **Block** issues: fix immediately.
- **Ship-with-followup**: fix if trivial; otherwise file in `wishlist.md` and proceed.
- **Nit**: fix in batch with main agent edits; do not spawn flash agents for these.

If a Block fix touches multiple files in disjoint segments, may spawn
flash agents again (with a fresh, narrow prompt). Otherwise the main
agent does the edits.

### 9.3 Re-verify

Run the Phase 2 verification commands again. All must be green.

### 9.4 Await user direction

Do NOT commit. Do NOT push. Surface the diff stat and a summary of what
changed. Wait for the user to say "commit and push" or equivalent.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `currentChunks` race between read and serialize | Single-threaded JS; the snapshot is built synchronously in `getAllStatuses`. Defensive copy further isolates the consumer. |
| WS `statuses` event arrives during `hydrateFromBackend` and double-applies state | `hydrateFromBackend` checks `tabs.length > 0` and bails; conversely, the WS `statuses` handler is per-tab idempotent (uses snapshot as authoritative state, doesn't append duplicates). |
| Hydration restores an archived tab if `is_open` was flipped after a crash | `listOpenTabs` filters on `is_open = 1`. No path in this plan touches that filter. |
| User has 50 tabs and hydration is slow | `messageFetches` runs in `Promise.all`; bottleneck is total DB row count, not request count. Acceptable for v1. If it becomes a problem, add `?limit=N` to `/tabs/:id/messages`. |
| Subagent (`parentTabId != null`) tabs restore with `persistent: true` and never auto-clean | Existing `persistent: true` semantics in `createNewTab` already apply to user tabs; subagent tabs created via WS `tab-created` keep their non-persistent flag. Hydration restores them as persistent (matching the "they survived a reload, the user clearly cares") — acceptable. |
| The `currentAssistantId` from the snapshot doesn't match any DB message id | `hydrateFromBackend` and the `statuses` handler both append a new in-flight message in this case. Subsequent `done` will close it correctly. |

---

## 11. Acceptance checklist

Before declaring done, the main agent verifies:

- [ ] Open a tab, send a message that triggers a long response, close the browser DURING the response, reopen the browser: the message completes in the restored tab (visible in chat history).
- [ ] Open a tab, send a message that triggers a long response, close the browser DURING the response, immediately reopen: the response is streaming live (the user sees deltas appearing).
- [ ] Open three tabs, close the browser, reopen: all three tabs appear in the same order, with their messages.
- [ ] Open three tabs, click the X on the middle one, close the browser, reopen: two tabs remain (not three) — the closed one was archived.
- [ ] Open a tab, send a message, click the X on the tab DURING the response, reopen the browser: the tab is gone AND the agent didn't keep running (verifiable by checking that the tab's last assistant message has a `cancelled` system chunk in the DB, and that no subsequent assistant content was appended).
- [ ] First-ever browser load with no tabs in the DB: a fresh empty tab is created (the existing default UX).
