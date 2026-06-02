import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

/**
 * A tab reference surfaced to the `send_to_tab` / `read_tab` tools. The tools
 * are intentionally decoupled from the DB `TabRow` shape — the AgentManager
 * maps `resolveTabPrefix(...)` results down to this minimal projection so the
 * tools (and their unit tests) never depend on the persistence layer.
 */
export interface ResolvedTabRef {
	/** The tab's canonical full UUID. */
	id: string;
	/** The tab's display title (for disambiguation hints). */
	title: string;
	/** The tab's current short handle (shortest unique prefix). */
	handle: string;
}

/**
 * Outcome of resolving a short tab handle. Mirrors core's
 * `ResolveTabPrefixResult` but over the minimal `ResolvedTabRef` projection.
 */
export type TabResolution =
	| { status: "ok"; tab: ResolvedTabRef }
	| { status: "none" }
	| { status: "ambiguous"; matches: ResolvedTabRef[] };

export interface SendToTabCallbacks {
	/** Resolve a (possibly short) handle to one open tab. */
	resolveShortId(prefix: string): TabResolution;
	/**
	 * Deliver `message` to `tabId`. If the target is mid-turn the message is
	 * queued (same path as a user message); if idle/errored it wakes the tab
	 * and starts a new turn. Returns quickly — does NOT block on the turn.
	 */
	deliver(
		tabId: string,
		message: string,
	):
		| Promise<{ status: "queued" | "started" | "suppressed" }>
		| { status: "queued" | "started" | "suppressed" };
	/** Snapshot of currently-open tabs, for "available tabs" error hints. */
	listOpenHandles(): Array<{ handle: string; title: string }>;
	/** The calling tab's own id + handle — used to block self-sends and to
	 *  stamp provenance onto the delivered message. */
	self: { id: string; handle: string };
}

/** Render the "available tabs" hint shared by the none/ambiguous branches. */
function renderOpenHandles(handles: Array<{ handle: string; title: string }>): string {
	if (handles.length === 0) return "No other tabs are currently open.";
	const lines = handles.map((h) => `  - ${h.handle}: ${h.title}`);
	return ["Currently open tabs:", ...lines].join("\n");
}

export function createSendToTabTool(callbacks: SendToTabCallbacks): ToolDefinition {
	return {
		name: "send_to_tab",
		description: [
			"Send a message to another tab (agent) by its short ID — the handle shown in the tab bar.",
			"",
			"Behaviour mirrors a user sending a message:",
			"  - If the target tab is mid-turn (busy), your message is QUEUED and picked up next.",
			"  - If the target tab is idle, your message WAKES it and starts a new turn.",
			"",
			"This is fire-and-forget: it returns immediately and does NOT wait for a reply.",
			"Do NOT sleep, poll, or run shell commands to wait for a reply — that wastes turns and",
			"money. If the target replies it arrives on its own as a new message in a later turn; you",
			"can also call 'read_tab' with the same ID in a FUTURE turn to check. If you have other",
			"work to do, keep going; if you are ONLY waiting for the reply, end your turn now.",
			"",
			"Your tab ID is auto-added to the top of the message so the recipient knows who to reply",
			"to. The recipient must use this same 'send_to_tab' tool (addressed to your ID) to answer;",
			"a plain text response reaches only their own user, not you.",
			"IDs are git-style prefixes: pass any length that uniquely identifies the target (min 4 chars).",
			"If the ID is ambiguous you'll be asked to add a character.",
		].join("\n"),
		parameters: z.object({
			tab_id: z
				.string()
				.describe(
					"The short ID (handle) of the target tab, as shown in the tab bar. Any unique-length prefix of the tab's id works (min 4 chars).",
				),
			message: z
				.string()
				.describe("The message to deliver to the target tab, exactly as a user would type it."),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const rawId = (args.tab_id as string | undefined)?.trim() ?? "";
			const message = (args.message as string | undefined) ?? "";

			if (!rawId) {
				return `Error: tab_id is required.\n\n${renderOpenHandles(callbacks.listOpenHandles())}`;
			}
			if (!message.trim()) {
				return "Error: message must not be empty.";
			}

			const resolution = callbacks.resolveShortId(rawId);

			if (resolution.status === "none") {
				return [
					`Error: no open tab matches the ID "${rawId}".`,
					"",
					renderOpenHandles(callbacks.listOpenHandles()),
				].join("\n");
			}
			if (resolution.status === "ambiguous") {
				const matches = resolution.matches.map((m) => `  - ${m.handle}: ${m.title}`).join("\n");
				return [
					`Error: the ID "${rawId}" is ambiguous — it matches multiple open tabs:`,
					matches,
					"",
					"Add one or more characters to disambiguate.",
				].join("\n");
			}

			const target = resolution.tab;

			if (target.id === callbacks.self.id) {
				return "Error: cannot send a message to your own tab.";
			}

			// Stamp provenance so the recipient (and the watching user) can see
			// which tab the message came from and how to reply. The header makes
			// clear this is a PEER AGENT, not the recipient's own user, and the
			// footer states the reply contract: a reply (only if warranted) must
			// go back through `send_to_tab`, since a plain text answer reaches
			// only the recipient's own user — not this sender.
			const delivered = [
				`[message from tab ${callbacks.self.handle} — this is another agent, NOT your user]`,
				"",
				message,
				"",
				`[To reply to tab ${callbacks.self.handle}, use the send_to_tab tool with tab_id "${callbacks.self.handle}". Only reply if this message asks you to, or your user tells you to — it may just be context or instructions. A plain text response goes to your own user, not to this agent.]`,
			].join("\n");

			try {
				const result = await callbacks.deliver(target.id, delivered);
				if (result.status === "suppressed") {
					// The target hit its automatic agent-to-agent wake limit. The
					// message was preserved (queued) but did NOT start a turn — a
					// human must step in. Tell the sender plainly so it stops
					// hammering the target and creating a runaway loop.
					return [
						`Message HELD for tab ${target.handle} (${target.title}) — it was NOT delivered as a wake.`,
						`That tab has reached its automatic agent-to-agent message limit, so it will not`,
						`auto-respond again until a human sends it a message. Do not keep resending:`,
						`your message is already queued and will be seen when a human resumes that tab.`,
					].join("\n");
				}
				const verb =
					result.status === "queued"
						? "queued (target is busy; it will be picked up next turn)"
						: "delivered (target was idle; a new turn has started)";
				return [
					`Message ${verb}. Target tab: ${target.handle} (${target.title}).`,
					"",
					"Do NOT sleep, poll, or run commands to wait for a reply. If the target replies it",
					`arrives on its own as a new message later; you can also call read_tab with "${target.handle}"`,
					"in a FUTURE turn to check. Keep working if you have other tasks; if you are ONLY",
					"waiting for this reply, end your turn now.",
				].join("\n");
			} catch (err) {
				return `Error delivering message: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
