// @dispatch/core — ntfy.sh push notifications

export {
	clearNtfyConfig,
	defaultNtfyConfig,
	loadNtfyConfig,
	NTFY_CONFIG_KEY,
	normalizeNtfyConfig,
	redactNtfyConfig,
	saveNtfyConfig,
} from "./config.js";
export {
	type AgentEventSource,
	type DispatcherOptions,
	NotificationDispatcher,
	type PermissionPromptSource,
	type TabTitleLookup,
} from "./dispatcher.js";
export { type FetchLike, type NtfySendResult, sendNtfy, validateTopicUrl } from "./ntfy.js";
export {
	type NotificationEvent,
	type NotificationEventType,
	NTFY_DEFAULT_EVENTS,
	NTFY_DEFAULT_PRIORITIES,
	NTFY_DEFAULT_TAGS,
	NTFY_EVENT_TYPES,
	type NtfyConfig,
	type NtfyPriority,
} from "./types.js";
