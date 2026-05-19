import type { ZodType } from "zod";
import type { PermissionChecker, Ruleset } from "../permission/index.js";

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
	toolName: string;
	result: string;
	isError: boolean;
}

// Agent status
export type AgentStatus = "idle" | "running" | "error";

// Agent events emitted during execution (for WebSocket streaming)
export type AgentEvent =
	| { type: "status"; status: AgentStatus }
	| { type: "text-delta"; delta: string }
	| { type: "reasoning-delta"; delta: string }
	| { type: "tool-call"; toolCall: ToolCall }
	| { type: "tool-result"; toolResult: ToolResult }
	| { type: "shell-output"; data: string; stream: "stdout" | "stderr" }
	| { type: "error"; error: string }
	| { type: "done"; message: ChatMessage };

// Context passed to tool execute functions
export interface ToolExecuteContext {
	onOutput?: (data: string, stream: "stdout" | "stderr") => void;
}

// Tool definition interface
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: ZodType;
	execute: (args: Record<string, unknown>, context?: ToolExecuteContext) => Promise<string>;
}

// Agent configuration
export interface AgentConfig {
	model: string;
	apiKey: string;
	baseURL: string;
	systemPrompt: string;
	tools: ToolDefinition[];
	workingDirectory: string;
	permissionChecker?: PermissionChecker;
	ruleset?: Ruleset;
}
