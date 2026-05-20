export interface ToolCallDisplay {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	shellOutput?: { stdout: string; stderr: string };
}

export interface DebugInfo {
	timestamp: string;
	error?: string;
	model?: string;
	apiBase?: string;
	connectionStatus?: string;
	agentStatus?: string;
	rawEvent?: unknown;
	httpStatus?: number;
	httpBody?: string;
}

export type ContentSegment =
	| { type: "text"; text: string }
	| ({ type: "tool-call" } & ToolCallDisplay);

export interface ChatMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: ContentSegment[];
	thinking?: string;
	isStreaming?: boolean;
	debugInfo?: DebugInfo;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type AgentEvent =
	| { type: "status"; status: "idle" | "running" | "error" }
	| { type: "text-delta"; delta: string }
	| { type: "reasoning-delta"; delta: string }
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
	| { type: "shell-output"; data: string; stream: "stdout" | "stderr" };

export interface TaskItem {
	id: string;
	title: string;
	description: string;
	status: "pending" | "in_progress" | "done" | "blocked";
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

export interface ModelInfo {
	id: string;
	provider: string;
	tags: string[];
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

export type KeyUsageData = ClaudeUsageData | OpencodeUsageData | CopilotUsageData;
