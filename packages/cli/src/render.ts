/**
 * Pure event renderer — zero I/O.
 *
 * Maps an AgentEvent to optional stdout/stderr strings.
 * Consumers write these to process.stdout / process.stderr.
 */

import type { AgentEvent, ConversationMeta } from "@dispatch/transport-contract";

interface RenderOpts {
	readonly showReasoning: boolean;
}

interface RenderOutput {
	readonly stdout?: string;
	readonly stderr?: string;
}

export function renderEvent(e: AgentEvent, opts: RenderOpts): RenderOutput | undefined {
	switch (e.type) {
		case "text-delta":
			return { stdout: e.delta };
		case "reasoning-delta":
			return opts.showReasoning ? { stdout: e.delta } : undefined;
		case "tool-call":
			return { stdout: `\n[tool] ${e.toolName} ${JSON.stringify(e.input)}\n` };
		case "tool-output":
			return { stdout: e.data };
		case "tool-result":
			return {
				stdout: `[tool:${e.toolName}]${e.isError ? " ERROR" : ""} ${e.content}\n`,
			};
		case "usage":
			return {
				stdout: `\n[usage] in=${e.usage.inputTokens} out=${e.usage.outputTokens}\n`,
			};
		case "error":
			return { stderr: `[error] ${e.message}\n` };
		case "status":
		case "turn-start":
		case "turn-sealed":
		case "done":
			return undefined;
	}
}

/**
 * Accumulate ALL `text-delta` events' `delta` text into one string — the full
 * assistant reply assembled from a turn's event stream. Pure: input → output,
 * no I/O. Returns the empty string when the stream had no text deltas.
 */
export function extractLastText(events: readonly AgentEvent[]): string {
	let text = "";
	for (const e of events) {
		if (e.type === "text-delta") {
			text += e.delta;
		}
	}
	return text;
}

/**
 * Render an epoch-ms timestamp as a short relative phrase ("just now", "5m ago",
 * "3h ago", "2d ago") or, past a week, the `YYYY-MM-DD` date. `now` is injected
 * (clock is an outermost edge) so the function is pure and testable.
 */
export function formatRelativeTime(epochMs: number, now: number): string {
	const delta = now - epochMs;
	if (delta < 60_000) return "just now";
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Format the conversation list as a table — one row per conversation:
 * `shortId | title | lastActivity (relative)`. Empty input yields the empty
 * string. `now` is injected for `formatRelativeTime` (pure + testable).
 */
export function formatConversationList(
	conversations: readonly ConversationMeta[],
	now: number,
): string {
	if (conversations.length === 0) return "";
	return conversations
		.map((c) => `${c.id.slice(0, 8)} | ${c.title} | ${formatRelativeTime(c.lastActivityAt, now)}`)
		.join("\n");
}
