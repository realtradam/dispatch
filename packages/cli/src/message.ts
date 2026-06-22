/**
 * Pure message composition — zero I/O.
 *
 * Combines text and file content into a single message string,
 * and builds a ChatRequest from a parsed command.
 */

import type { ChatRequest, ReasoningEffort } from "@dispatch/transport-contract";

interface ComposeInput {
	readonly text?: string;
	readonly file?: string;
	readonly fileContent?: string;
}

function basename(filePath: string): string {
	const segments = filePath.split("/");
	return segments[segments.length - 1] ?? filePath;
}

export function composeMessage(input: ComposeInput): string {
	const { text, fileContent } = input;
	const file = input.file;

	if (text && file) {
		return `${text}\n\nAttached file (${basename(file)}):\n${fileContent ?? ""}`;
	}
	if (file) {
		return `Attached file (${basename(file)}):\n${fileContent ?? ""}`;
	}
	return text ?? "";
}

interface ChatCmd {
	readonly modelName: string;
	readonly text?: string | undefined;
	readonly file?: string | undefined;
	readonly cwd?: string | undefined;
	readonly conversationId?: string | undefined;
	readonly reasoningEffort?: ReasoningEffort | undefined;
	readonly workspaceId?: string | undefined;
	readonly showReasoning: boolean;
}

interface BuildCtx {
	readonly cwd: string;
	readonly message: string;
}

export function buildChatRequest(cmd: ChatCmd, ctx: BuildCtx): ChatRequest {
	return {
		message: ctx.message,
		model: cmd.modelName,
		...(cmd.conversationId !== undefined && { conversationId: cmd.conversationId }),
		...(cmd.cwd !== undefined ? { cwd: cmd.cwd } : { cwd: ctx.cwd }),
		...(cmd.reasoningEffort !== undefined && { reasoningEffort: cmd.reasoningEffort }),
		...(cmd.workspaceId !== undefined && { workspaceId: cmd.workspaceId }),
	};
}
