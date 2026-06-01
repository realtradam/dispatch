// ntfy.sh push notifications — types

/**
 * Catalog of notification-worthy events.
 *
 * Kept intentionally small and stable: each entry is something a human
 * actually wants pushed to their phone. New event types should be added
 * with a sensible default (`NTFY_DEFAULT_EVENTS`) and a mapping in the
 * dispatcher.
 */
export type NotificationEventType =
	| "turn-completed"
	| "turn-error"
	| "permission-required"
	| "agent-spawned";

/** ntfy priority levels (1=min … 5=max). */
export type NtfyPriority = 1 | 2 | 3 | 4 | 5;

/**
 * A single notification request. Synthesised by the dispatcher from a
 * higher-level event source (AgentManager / PermissionManager); fed to
 * the ntfy transport.
 *
 * `dedupeKey` lets the dispatcher suppress duplicate sends (e.g. the
 * permission system re-emits the pending list on every change).
 */
export interface NotificationEvent {
	type: NotificationEventType;
	/** Notification title (short). */
	title: string;
	/** Notification body. */
	message: string;
	/** Optional ntfy tags (emoji shortcodes — e.g. `["white_check_mark"]`). */
	tags?: string[];
	/** Optional priority override. Defaults are per-event-type. */
	priority?: NtfyPriority;
	/** Optional URL the notification deep-links to when tapped. */
	clickUrl?: string;
	/** Origin tab id (informational; included in tags as `tab:<short>`). */
	tabId?: string;
	/**
	 * Stable key for suppressing duplicates. Same key + same type within a
	 * short window ⇒ dropped silently.
	 */
	dedupeKey?: string;
}

/**
 * Persisted ntfy configuration. Lives in the `settings` table under a
 * single key (`ntfy_config`) — one global config, matching the codebase's
 * existing single-user assumption (cf. `title_model_*`, `perm_*`).
 *
 * - `enabled` — master switch. Off ⇒ dispatcher never sends.
 * - `topic`   — bare ntfy.sh topic name, e.g. `my-secret-topic`. The
 *   server is hardcoded to https://ntfy.sh; the user only picks a topic.
 *   Missing ⇒ dispatcher never sends.
 * - `authToken` — optional bearer token (rarely needed against ntfy.sh
 *   directly; preserved for users behind an auth-protected proxy).
 * - `events` — per-event-type enable map. Missing entries default to OFF
 *   so a newly-added event type doesn't silently start firing.
 * - `notifySubagents` — when false (default), `turn-completed` and
 *   `turn-error` notifications from subagent tabs (tabs with a
 *   `parentTabId`) are suppressed. A parent agent that spawns 8
 *   subagents would otherwise push 9 "Turn complete" notifications per
 *   round — usually noise. `permission-required` is NOT gated: even a
 *   subagent's permission prompt needs a human tap to proceed.
 *   `agent-spawned` is already top-level-only by construction.
 */
export interface NtfyConfig {
	enabled: boolean;
	topic: string;
	authToken: string;
	events: Record<NotificationEventType, boolean>;
	notifySubagents: boolean;
}

/** All event types this build knows about (the source of truth for UI). */
export const NTFY_EVENT_TYPES: NotificationEventType[] = [
	"turn-completed",
	"turn-error",
	"permission-required",
	"agent-spawned",
];

/** Default per-event-type toggles. */
export const NTFY_DEFAULT_EVENTS: Record<NotificationEventType, boolean> = {
	"turn-completed": true,
	"turn-error": true,
	"permission-required": true,
	"agent-spawned": false,
};

/** Default priority per event type (when the event itself doesn't override). */
export const NTFY_DEFAULT_PRIORITIES: Record<NotificationEventType, NtfyPriority> = {
	"turn-completed": 3,
	"turn-error": 4,
	"permission-required": 4,
	"agent-spawned": 2,
};

/** Default tag (emoji) per event type. */
export const NTFY_DEFAULT_TAGS: Record<NotificationEventType, string[]> = {
	"turn-completed": ["white_check_mark"],
	"turn-error": ["rotating_light"],
	"permission-required": ["lock"],
	"agent-spawned": ["sparkles"],
};
