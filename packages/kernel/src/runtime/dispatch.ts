import type { ToolDispatchPolicy } from "../contracts/dispatch.js";
import type { EventEmitter } from "../contracts/runtime.js";
import type { ToolCall, ToolContract, ToolExecuteContext, ToolResult } from "../contracts/tool.js";
import { toolOutputEvent } from "./events.js";

export interface StepDispatcher {
	submit(call: ToolCall): void;
	drain(): Promise<Map<string, ToolResult>>;
}

export async function executeToolCall(
	call: ToolCall,
	tool: ToolContract | undefined,
	signal: AbortSignal,
	emit: EventEmitter,
	conversationId: string,
	turnId: string,
): Promise<ToolResult> {
	if (tool === undefined) {
		return { content: `Unknown tool: ${call.name}`, isError: true };
	}
	if (signal.aborted) {
		return { content: "Aborted", isError: true };
	}
	const ctx: ToolExecuteContext = {
		toolCallId: call.id,
		signal,
		onOutput: (data, stream) => {
			emit(toolOutputEvent(conversationId, turnId, call.id, data, stream));
		},
	};
	try {
		return await tool.execute(call.input, ctx);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { content: `Tool execution error: ${message}`, isError: true };
	}
}

interface QueueEntry {
	readonly call: ToolCall;
	readonly tool: ToolContract | undefined;
	readonly resolve: (result: ToolResult) => void;
}

export function createStepDispatcher(
	toolMap: Map<string, ToolContract>,
	policy: ToolDispatchPolicy,
	signal: AbortSignal,
	emit: EventEmitter,
	conversationId: string,
	turnId: string,
): StepDispatcher {
	let activeCount = 0;
	let unsafeRunning = false;
	const queue: QueueEntry[] = [];
	const allPromises: Array<{ id: string; promise: Promise<ToolResult> }> = [];
	const dedupMap = new Map<string, Promise<ToolResult>>();

	function canStart(isConcurrencySafe: boolean): boolean {
		if (unsafeRunning) return false;
		if (!isConcurrencySafe && activeCount > 0) return false;
		if (policy.maxConcurrent === 0) return true;
		return activeCount < policy.maxConcurrent;
	}

	function tryStartNext(): void {
		while (queue.length > 0) {
			const next = queue[0];
			if (next === undefined) break;
			const isSafe = next.tool?.concurrencySafe !== false;
			if (!canStart(isSafe)) break;
			queue.shift();
			activeCount++;
			if (!isSafe) unsafeRunning = true;
			void runAndResolve(next);
		}
	}

	async function runAndResolve(entry: QueueEntry): Promise<void> {
		const result = await executeToolCall(
			entry.call,
			entry.tool,
			signal,
			emit,
			conversationId,
			turnId,
		);
		activeCount--;
		if (entry.tool?.concurrencySafe === false) unsafeRunning = false;
		entry.resolve(result);
		tryStartNext();
	}

	function submit(call: ToolCall): void {
		const tool = toolMap.get(call.name);
		const key = `${call.name}:${JSON.stringify(call.input)}`;

		const existing = dedupMap.get(key);
		if (existing !== undefined) {
			allPromises.push({ id: call.id, promise: existing });
			return;
		}

		const promise = new Promise<ToolResult>((resolve) => {
			queue.push({ call, tool, resolve });
			tryStartNext();
		});

		dedupMap.set(key, promise);
		allPromises.push({ id: call.id, promise });
	}

	async function drain(): Promise<Map<string, ToolResult>> {
		if (signal.aborted) {
			for (const item of queue) {
				item.resolve({ content: "Aborted", isError: true });
			}
			queue.length = 0;
		}

		const results = new Map<string, ToolResult>();
		for (const entry of allPromises) {
			const result = await entry.promise;
			results.set(entry.id, result);
		}
		return results;
	}

	return { submit, drain };
}
