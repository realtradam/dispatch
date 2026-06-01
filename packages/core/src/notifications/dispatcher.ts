// NotificationDispatcher — turns high-level Dispatch events into
// `sendNtfy(...)` calls, gated by the persisted user config.
//
// The dispatcher is transport-agnostic at the `notify(event)` interface
// boundary: only `sendNtfy` is wired today, but adding another transport
// (email, webhook, etc.) means changing this one file, not the call sites.
//
// All sends are non-blocking (fire-and-forget). A 10-second timeout in
// `sendNtfy` bounds the worst case; the dispatcher additionally guards
// every send in a try/catch so a transport bug can never propagate into
// the agent loop.

import { loadNtfyConfig } from "./config.js";
import { type FetchLike, sendNtfy } from "./ntfy.js";
import type { NotificationEvent, NtfyConfig } from "./types.js";

/** Minimal shape of an `AgentManager`-style event stream we hook into. */
export interface AgentEventSource {
	onEvent(
		listener: (event: { type: string; tabId: string; [key: string]: unknown }) => void,
	): () => void;
}

/** Minimal shape of a `PermissionManager`-style prompt source. */
export interface PermissionPromptSource {
	onPromptAdded(
		listener: (prompt: { id: string; permission: string; description: string }) => void,
	): () => void;
}

/** Look up a human-readable tab title for nicer notification text. */
export type TabTitleLookup = (tabId: string) => string | null;

export interface DispatcherOptions {
	/** Override the config loader (tests). Defaults to `loadNtfyConfig`. */
	loadConfig?: () => NtfyConfig;
	/** Override the transport (tests). Defaults to the real `sendNtfy`. */
	send?: (config: NtfyConfig, event: NotificationEvent) => Promise<unknown>;
	/** Optional fetch override (forwarded to `sendNtfy` when `send` not set). */
	fetchImpl?: FetchLike;
	/** Look up a tab title for richer titles. */
	getTabTitle?: TabTitleLookup;
	/**
	 * How long (ms) a dedupeKey is suppressed for. Permission prompts re-emit
	 * the whole pending list on every change, so dedupe is essential.
	 */
	dedupeWindowMs?: number;
}

export class NotificationDispatcher {
	private loadConfig: () => NtfyConfig;
	private send: (config: NtfyConfig, event: NotificationEvent) => Promise<unknown>;
	private getTabTitle: TabTitleLookup | undefined;
	private dedupeWindowMs: number;
	/** Recently-sent dedupeKey → expiresAt epoch ms. */
	private recentlySent = new Map<string, number>();
	private unsubs: Array<() => void> = [];

	constructor(opts: DispatcherOptions = {}) {
		this.loadConfig = opts.loadConfig ?? loadNtfyConfig;
		this.send =
			opts.send ?? ((config, event) => sendNtfy(config, event, opts.fetchImpl ?? undefined));
		this.getTabTitle = opts.getTabTitle;
		this.dedupeWindowMs = opts.dedupeWindowMs ?? 5_000;
	}

	/**
	 * Single internal entry point — every public hook funnels through here.
	 * Public so a future caller can synthesize an arbitrary notification
	 * (e.g. a CLI `dispatch notify` command); kept narrow.
	 */
	notify(event: NotificationEvent): void {
		const config = this.loadConfig();
		if (!config.enabled) return;
		if (!config.events[event.type]) return;
		if (event.dedupeKey && this.isDuplicate(event.dedupeKey)) return;
		if (event.dedupeKey) this.markSent(event.dedupeKey);

		// Fire-and-forget: never await, never throw.
		try {
			void Promise.resolve(this.send(config, event)).catch((err) => {
				console.warn(
					`[ntfy] send failed for ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		} catch (err) {
			// Guard the synchronous portion of `send` too.
			console.warn(
				`[ntfy] dispatch threw for ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Hook into an `AgentManager`-style event stream.
	 *
	 * Maps:
	 *   - `done`            → `turn-completed`
	 *   - `error`           → `turn-error`
	 *   - `tab-created`     → `agent-spawned` (only top-level user-agent tabs)
	 *
	 * `status` events are ignored — they fire on every transition and we'd
	 * either spam or duplicate the `done`/`error` notifications.
	 */
	attachToAgentManager(source: AgentEventSource): () => void {
		const unsub = source.onEvent((event) => {
			if (event.type === "done") {
				this.notify(this.buildTurnCompleted(event));
			} else if (event.type === "error") {
				this.notify(this.buildTurnError(event));
			} else if (event.type === "tab-created") {
				const ev = event as unknown as {
					tabId: string;
					id: string;
					title: string;
					parentTabId: string | null;
					agentSlug?: string | null;
				};
				// Only notify for top-level user-agent tabs spawned via `summon`.
				// Filtering on `agentSlug` skips "blank" new tabs the user opened
				// manually, which would be noisy.
				if (ev.parentTabId === null && ev.agentSlug) {
					this.notify(this.buildAgentSpawned(ev));
				}
			}
		});
		this.unsubs.push(unsub);
		return unsub;
	}

	/** Hook into a `PermissionManager`-style prompt source. */
	attachToPermissionManager(source: PermissionPromptSource): () => void {
		const unsub = source.onPromptAdded((prompt) => {
			this.notify(this.buildPermissionRequired(prompt));
		});
		this.unsubs.push(unsub);
		return unsub;
	}

	/** Release all hooks acquired via `attachTo*`. */
	dispose(): void {
		for (const u of this.unsubs) {
			try {
				u();
			} catch {
				// best-effort
			}
		}
		this.unsubs = [];
		this.recentlySent.clear();
	}

	// ─── Event builders (internal) ────────────────────────────────

	private buildTurnCompleted(event: { tabId: string }): NotificationEvent {
		const tabLabel = this.tabLabel(event.tabId);
		return {
			type: "turn-completed",
			title: `Turn complete — ${tabLabel}`,
			message: `Assistant finished a turn in ${tabLabel}.`,
			tabId: event.tabId,
		};
	}

	private buildTurnError(event: {
		tabId: string;
		error?: unknown;
		statusCode?: unknown;
	}): NotificationEvent {
		const tabLabel = this.tabLabel(event.tabId);
		const errText = typeof event.error === "string" ? event.error : "Unknown error";
		const statusText = typeof event.statusCode === "number" ? ` (status ${event.statusCode})` : "";
		return {
			type: "turn-error",
			title: `Turn failed — ${tabLabel}`,
			message: `${errText}${statusText}`,
			tabId: event.tabId,
		};
	}

	private buildPermissionRequired(prompt: {
		id: string;
		permission: string;
		description: string;
	}): NotificationEvent {
		return {
			type: "permission-required",
			title: `Permission required: ${prompt.permission}`,
			message: prompt.description || `Agent is requesting ${prompt.permission} permission.`,
			// Permission prompts can re-emit (e.g. another prompt arrives while
			// this one is still pending) — dedupe on the prompt id.
			dedupeKey: `permission:${prompt.id}`,
		};
	}

	private buildAgentSpawned(ev: {
		tabId: string;
		id: string;
		title: string;
		agentSlug?: string | null;
	}): NotificationEvent {
		return {
			type: "agent-spawned",
			title: `User agent spawned — ${ev.agentSlug ?? "agent"}`,
			message: ev.title,
			tabId: ev.tabId ?? ev.id,
		};
	}

	private tabLabel(tabId: string): string {
		const title = this.getTabTitle?.(tabId);
		if (title?.trim()) return title.trim();
		return `tab ${tabId.slice(0, 8)}`;
	}

	// ─── Dedupe helpers ───────────────────────────────────────────

	private isDuplicate(key: string): boolean {
		const expires = this.recentlySent.get(key);
		if (expires === undefined) return false;
		if (expires <= Date.now()) {
			this.recentlySent.delete(key);
			return false;
		}
		return true;
	}

	private markSent(key: string): void {
		// Lazy-evict expired entries when the map gets large.
		if (this.recentlySent.size > 256) {
			const now = Date.now();
			for (const [k, exp] of this.recentlySent) {
				if (exp <= now) this.recentlySent.delete(k);
			}
		}
		this.recentlySent.set(key, Date.now() + this.dedupeWindowMs);
	}
}
