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
