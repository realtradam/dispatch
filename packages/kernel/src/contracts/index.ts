/**
 * Kernel contracts barrel — the stable ABI every extension compiles against.
 *
 * Re-exports all contract types and pure helpers. No implementations, no I/O,
 * no concrete feature names. This is the only surface extensions depend on
 * from the kernel.
 */

export type {
	ApiKeyCredentials,
	AuthContract,
	BearerTokenCredentials,
	Credentials,
} from "./auth.js";
export type {
	ChatMessage,
	Chunk,
	ErrorChunk,
	Role,
	StepId,
	SystemChunk,
	TextChunk,
	ThinkingChunk,
	ToolCallChunk,
	ToolResultChunk,
	TurnId,
} from "./conversation.js";
export type { ToolDispatchPolicy } from "./dispatch.js";
export type {
	AgentEvent,
	StatusEvent,
	TurnDoneEvent,
	TurnErrorEvent,
	TurnReasoningDeltaEvent,
	TurnSealedEvent,
	TurnStartEvent,
	TurnTextDeltaEvent,
	TurnToolCallEvent,
	TurnToolOutputEvent,
	TurnToolResultEvent,
	TurnUsageEvent,
} from "./events.js";
export type {
	ConfigAccess,
	EventsEmitter,
	Extension,
	HostAPI,
	Logger,
	Manifest,
	ManifestCapabilities,
	ManifestContributions,
	PermissionDecision,
	PermissionGate,
	PermissionRequest,
	ScheduledJob,
	SecretsAccess,
	StorageNamespace,
	TrustLevel,
} from "./extension.js";

export type {
	EventHandler,
	EventHookDescriptor,
	FilterDescriptor,
	FilterHandler,
	HookDescriptor,
	ServiceHandle,
} from "./hooks.js";

export { defineEventHook, defineFilter, defineService } from "./hooks.js";
export type {
	FinishEvent,
	ProviderContract,
	ProviderErrorEvent,
	ProviderEvent,
	ProviderStreamOptions,
	ProviderToolCallEvent,
	ReasoningDeltaEvent,
	TextDeltaEvent,
	Usage,
	UsageEvent,
} from "./provider.js";
export type {
	EventEmitter,
	RunTurnInput,
	RunTurnResult,
} from "./runtime.js";
export type {
	JsonSchemaProperty,
	ToolCall,
	ToolContract,
	ToolExecuteContext,
	ToolParameterSchema,
	ToolResult,
} from "./tool.js";
