import type { ZodType } from "zod";

// Message types for the agent conversation
export type MessageRole = "user" | "assistant" | "tool";

export interface ChatMessage {
	role: MessageRole;
	content: string;
	toolCalls?: ToolCall[];
	toolResults?: ToolResult[];
}

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResult {
	toolCallId: string;
	result: string;
	isError: boolean;
}

// Agent status
export type AgentStatus = "idle" | "running" | "error";

// Agent events emitted during execution (for WebSocket streaming)
export type AgentEvent =
	| { type: "status"; status: AgentStatus }
	| { type: "text-delta"; delta: string }
	| { type: "tool-call"; toolCall: ToolCall }
	| { type: "tool-result"; toolResult: ToolResult }
	| { type: "error"; error: string }
	| { type: "done"; message: ChatMessage };

// Tool definition interface
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: ZodType;
	execute: (args: Record<string, unknown>) => Promise<string>;
}

// Agent configuration
export interface AgentConfig {
	model: string;
	apiKey: string;
	baseURL: string;
	systemPrompt: string;
	tools: ToolDefinition[];
	workingDirectory: string;
}
