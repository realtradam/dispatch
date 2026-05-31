import { z } from "zod";
import type { AgentStatus, ToolDefinition } from "../types/index.js";
import type { TabResolution } from "./send-to-tab.js";

export interface ReadTabCallbacks {
	/** Resolve a (possibly short) handle to one open tab. */
	resolveShortId(prefix: string): TabResolution;
	/**
	 * Return the target tab's most recent COMPLETED assistant turn as plain
	 * text, plus its current status. `text` is null when the tab has no
	 * completed assistant turn yet.
	 */
	getLastResponse(tabId: string): { text: string | null; status: AgentStatus };
	/** Snapshot of currently-open tabs, for "available tabs" error hints. */
	listOpenHandles(): Array<{ handle: string; title: string }>;
}

/** Render the "available tabs" hint shared by the none/ambiguous branches. */
function renderOpenHandles(handles: Array<{ handle: string; title: string }>): string {
	if (handles.length === 0) return "No other tabs are currently open.";
	const lines = handles.map((h) => `  - ${h.handle}: ${h.title}`);
	return ["Currently open tabs:", ...lines].join("\n");
}

export function createReadTabTool(callbacks: ReadTabCallbacks): ToolDefinition {
	return {
		name: "read_tab",
		description: [
			"Read the most recent completed response from another tab (agent) by its short ID.",
			"",
			"Returns a SNAPSHOT — it does NOT block or wait for the target to finish.",
			"  - If the target is idle, you get its just-finished turn.",
			"  - If the target is still running, you get its PREVIOUS completed turn (if any);",
			"    call read_tab again later to get the newest one.",
			"",
			"Use this after send_to_tab to collect another agent's reply. IDs are git-style",
			"prefixes: pass any length that uniquely identifies the target (min 4 chars).",
		].join("\n"),
		parameters: z.object({
			tab_id: z
				.string()
				.describe(
					"The short ID (handle) of the tab to read, as shown in the tab bar. Any unique-length prefix works (min 4 chars).",
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const rawId = (args.tab_id as string | undefined)?.trim() ?? "";

			if (!rawId) {
				return `Error: tab_id is required.\n\n${renderOpenHandles(callbacks.listOpenHandles())}`;
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
			const { text, status } = callbacks.getLastResponse(target.id);

			const runningNote =
				status === "running"
					? " (this tab is still running; the response below is its previous completed turn — read again later for the newest)"
					: "";

			if (text === null) {
				const reason =
					status === "running"
						? "it is still working on its first turn"
						: "it has no assistant responses yet";
				return `Tab ${target.handle} (${target.title}) has no completed response — ${reason}.`;
			}

			return [
				`<tab_response tab="${target.handle}" status="${status}"${runningNote}>`,
				text,
				"</tab_response>",
			].join("\n");
		},
	};
}
