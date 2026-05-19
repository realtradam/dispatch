export interface ToolCallDisplay {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
	isError?: boolean;
	isExpanded: boolean;
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
	role: "user" | "assistant";
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
	| {
			type: "done";
			message: {
				role: string;
				content: string;
				toolCalls?: unknown[];
				toolResults?: unknown[];
			};
	  };
