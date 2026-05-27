export interface DebugInfo {
	timestamp: string;
	error?: string;
	notice?: string;
	model?: string;
	apiBase?: string;
	connectionStatus?: string;
	agentStatus?: string;
	rawEvent?: unknown;
	httpStatus?: number;
	httpBody?: string;
}

/**
 * Mirror of the core `Chunk` union (see packages/core/src/types/index.ts).
 *
 * Wire-format symmetry MUST be kept with core. If you change one, change
 * the other. The frontend store calls into the shared
 * `appendEventToChunks` helper from core so the two stay in lockstep.
 */
export type Chunk = TextChunk | ThinkingChunk | ToolBatchChunk | ErrorChunk | SystemChunk;

export interface TextChunk {
	type: "text";
	text: string;
}

export interface ThinkingChunk {
	type: "thinking";
	text: string;
	/**
	 * Mirror of core. Anthropic's `providerMetadata` blob captured from
	 * the v6 `reasoning-end` stream event. Present once the backend has
	 * sealed the chunk; absent for in-flight thinking or for non-Anthropic
	 * models. The UI doesn't render this — it lives here for wire-format
	 * symmetry with the persisted chunk shape.
	 */
	metadata?: Record<string, unknown>;
}

export interface ToolBatchChunk {
	type: "tool-batch";
	calls: ToolBatchEntry[];
}

export interface ToolBatchEntry {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	shellOutput?: { stdout: string; stderr: string };
}

export interface ErrorChunk {
	type: "error";
	message: string;
	statusCode?: number;
}

export type SystemChunkKind = "notice" | "model-changed" | "config-reload" | "cancelled";

export interface SystemChunk {
	type: "system";
	kind: SystemChunkKind;
	text: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	chunks: Chunk[];
	isStreaming?: boolean;
	debugInfo?: DebugInfo;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type AgentEvent =
	| { type: "status"; status: "idle" | "running" | "error" }
	// Sent on every WS (re)connect: a snapshot of every tab the backend is
	// currently tracking and its live status. The frontend uses this to
	// detect desync after a reconnect (e.g. bun --watch restart killed the
	// in-flight agent state, frontend missed `done` / `status:idle` events).
	| { type: "statuses"; statuses: Record<string, "idle" | "running" | "error"> }
	| { type: "text-delta"; delta: string }
	| { type: "reasoning-delta"; delta: string }
	| { type: "reasoning-end"; metadata?: Record<string, unknown> }
	| {
			type: "tool-call";
			toolCall: {
				id: string;
				name: string;
				arguments: Record<string, unknown>;
			};
	  }
	| {
			type: "tool-result";
			toolResult: { toolCallId: string; result: string; isError: boolean };
	  }
	| { type: "error"; error: string }
	| { type: "notice"; message: string }
	| { type: "model-changed"; keyId: string; modelId: string }
	| { type: "task-list-update"; tasks: TaskItem[] }
	| { type: "config-reload" }
	| {
			type: "done";
			message: {
				role: string;
				content: string;
				toolCalls?: unknown[];
				toolResults?: unknown[];
			};
	  }
	| { type: "permission-prompt"; pending: PermissionPrompt[] }
	| { type: "shell-output"; data: string; stream: "stdout" | "stderr" }
	| {
			type: "tab-created";
			id: string;
			title: string;
			keyId: string | null;
			modelId: string | null;
			parentTabId: string | null;
	  }
	| { type: "message-queued"; tabId: string; messageId: string; message: string }
	| { type: "message-consumed"; tabId: string; messageIds: string[] }
	| { type: "message-cancelled"; tabId: string; messageId: string };

export interface TaskItem {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "done";
}

export interface PermissionPrompt {
	id: string;
	permission: string;
	patterns: string[];
	always: string[];
	description: string;
	metadata: Record<string, unknown>;
}

export interface ModelOverride {
	keyId: string;
	modelId: string;
}

export interface KeyInfo {
	id: string;
	provider: string;
	status: "active" | "exhausted";
	lastError: string | null;
	exhaustedAt: number | null;
}

export interface QueuedMessage {
	id: string;
	message: string;
	timestamp: number;
}

export interface LogEntry {
	id: string;
	permission: string;
	patterns: string[];
	action: "once" | "always" | "reject";
	timestamp: string;
	description: string;
}

export interface UsageBucket {
	utilization?: number;
	resetsAt?: number;
}

export interface ClaudeAccountUsage {
	label: string;
	source: string;
	subscriptionType?: string;
	fiveHour?: UsageBucket;
	sevenDay?: UsageBucket;
	error?: string;
}

export interface ClaudeUsageData {
	provider: "anthropic";
	accounts?: ClaudeAccountUsage[];
	fiveHour?: UsageBucket;
	sevenDay?: UsageBucket;
}

export interface OpencodeUsageData {
	provider: "opencode-go";
	unavailable?: boolean;
	consoleUrl?: string;
	limits?: { fiveHour?: string; weekly?: string; monthly?: string };
	fiveHour?: UsageBucket;
	weekly?: UsageBucket;
	monthly?: UsageBucket;
}

export interface CopilotUsageData {
	provider: "github-copilot";
	tokensConsumed?: number;
	tokensRemaining?: number;
	percentUsed?: number;
	resetAt?: number;
	plan?: string;
}

export interface GoogleUsageData {
	provider: "google";
	models?: Array<{
		name: string;
		inputTokenLimit: number;
		outputTokenLimit: number;
		rpm: number;
		requestsPerDay: number;
	}>;
	currentUsage?: {
		percentUsed: number;
		resetsAt?: string;
	};
	weeklyUsage?: {
		percentUsed: number;
		resetsAt?: string;
	};
}

export type KeyUsageData = ClaudeUsageData | OpencodeUsageData | CopilotUsageData | GoogleUsageData;
