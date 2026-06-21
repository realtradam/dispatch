/**
 * Composition root — the thin, untested shell that wires everything together.
 *
 * Reads process.argv, reads files, writes to stdout/stderr.
 * This is the ONLY file that touches I/O.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "./args.js";
import { formatCatalog } from "./catalog.js";
import {
	compactConversation,
	enqueueMessage,
	fetchConversations,
	fetchLastMessage,
	fetchModels,
	openConversation,
	resolveConversationId,
	stopTurn,
	streamChat,
} from "./http.js";
import { buildChatRequest, composeMessage } from "./message.js";
import { extractLastText, formatConversationList, renderEvent } from "./render.js";

const USAGE = `Usage:
  dispatch models [--server <url>]
  dispatch list [<prefix>] [--status <active|idle|closed>] [--all] [--server <url>]
  dispatch stop <conversationId> [--server <url>]
  dispatch compact <conversationId> [--server <url>]
  dispatch read <conversationId> [--server <url>]
  dispatch open <conversationId> [--server <url>]
  dispatch send <conversationId> --text "..." [--queue] [--open] [--cwd <dir>] [--effort <level>] [--server <url>]
  dispatch <modelName> --text "..." [--file <path>] [--cwd <dir>] [--conversation <id>] [--effort <level>] [--server <url>] [--show-reasoning] [--open]
  dispatch --help

Effort levels: low, medium, high (default), xhigh, max`;

async function main(): Promise<void> {
	const defaultServer = `http://localhost:${process.env.BACKEND_PORT ?? "24203"}`;
	const parsed = parseArgs(process.argv.slice(2), { defaultServer });

	switch (parsed.kind) {
		case "help":
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
			break;
		case "error":
			process.stderr.write(`Error: ${parsed.message}\n`);
			process.exit(1);
			break;
		case "models": {
			const result = await fetchModels({ fetchImpl: globalThis.fetch }, { server: parsed.server });
			process.stdout.write(`${formatCatalog(result)}\n`);
			break;
		}
		case "list": {
			const status = parsed.all ? undefined : (parsed.status ?? "active,idle");
			const result = await fetchConversations(
				{ fetchImpl: globalThis.fetch },
				{
					server: parsed.server,
					...(parsed.query !== undefined && { query: parsed.query }),
					...(status !== undefined && { status }),
				},
			);
			const table = formatConversationList(result.conversations, Date.now());
			if (table.length > 0) process.stdout.write(`${table}\n`);
			break;
		}
		case "read": {
			const resolved = await resolveConversationId(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, shortId: parsed.conversationId },
			);
			if (typeof resolved !== "string") {
				process.stderr.write(`${resolved.error}\n`);
				process.exit(1);
			}
			const last = await fetchLastMessage(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, conversationId: resolved },
			);
			if (last.content.length > 0) process.stdout.write(`${last.content}\n`);
			break;
		}
		case "compact": {
			const resolved = await resolveConversationId(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, shortId: parsed.conversationId },
			);
			if (typeof resolved !== "string") {
				process.stderr.write(`${resolved.error}\n`);
				process.exit(1);
			}
			const result = await compactConversation(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, conversationId: resolved },
			);
			process.stdout.write(
				`Compacted ${resolved}: ${result.messagesSummarized} messages summarized, ${result.messagesKept} kept.\n`,
			);
			break;
		}
		case "stop": {
			const resolved = await resolveConversationId(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, shortId: parsed.conversationId },
			);
			if (typeof resolved !== "string") {
				process.stderr.write(`${resolved.error}\n`);
				process.exit(1);
			}
			const result = await stopTurn(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, conversationId: resolved },
			);
			process.stdout.write(
				result.abortedTurn
					? `Stopped generation for ${resolved}\n`
					: `No active generation for ${resolved}\n`,
			);
			break;
		}
		case "open": {
			const resolved = await resolveConversationId(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, shortId: parsed.conversationId },
			);
			if (typeof resolved !== "string") {
				process.stderr.write(`${resolved.error}\n`);
				process.exit(1);
			}
			await openConversation(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, conversationId: resolved },
			);
			process.stdout.write(`Signaled frontend to open ${resolved}\n`);
			break;
		}
		case "send": {
			const resolved = await resolveConversationId(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, shortId: parsed.conversationId },
			);
			if (typeof resolved !== "string") {
				process.stderr.write(`${resolved.error}\n`);
				process.exit(1);
			}
			const conversationId = resolved;

			if (parsed.open) {
				await openConversation(
					{ fetchImpl: globalThis.fetch },
					{ server: parsed.server, conversationId },
				);
				process.stdout.write(`Signaled frontend to open ${conversationId}\n`);
			}

			if (parsed.queue) {
				const queued = await enqueueMessage(
					{ fetchImpl: globalThis.fetch },
					{ server: parsed.server, conversationId, text: parsed.text },
				);
				const line = queued.startedTurn
					? `Started turn for ${conversationId}`
					: `Queued to ${conversationId}`;
				process.stdout.write(`${line}\n`);
			} else {
				const request = {
					conversationId,
					message: parsed.text,
					...(parsed.cwd !== undefined && { cwd: parsed.cwd }),
					...(parsed.reasoningEffort !== undefined && { reasoningEffort: parsed.reasoningEffort }),
				};
				const { events } = await streamChat(
					{ fetchImpl: globalThis.fetch },
					{ server: parsed.server, request },
				);
				const collected = [];
				for await (const event of events) {
					if (event.type === "error") {
						process.stderr.write(`${event.message}\n`);
						process.exit(1);
					}
					collected.push(event);
					if (event.type === "done") break;
				}
				process.stdout.write(`${extractLastText(collected)}\n`);
				process.stdout.write(`[conversation] ${conversationId}\n`);
			}
			break;
		}
		case "chat": {
			let fileContent: string | undefined;
			if (parsed.file) {
				fileContent = await readFile(parsed.file, "utf-8");
			}

			const cwd = parsed.cwd ?? process.cwd();
			const message = composeMessage({
				...(parsed.text !== undefined && { text: parsed.text }),
				...(parsed.file !== undefined && { file: parsed.file }),
				...(fileContent !== undefined && { fileContent }),
			});
			const request = buildChatRequest(parsed, { cwd, message });

			const { conversationId, events } = await streamChat(
				{ fetchImpl: globalThis.fetch },
				{ server: parsed.server, request },
			);

			if (conversationId && parsed.open) {
				await openConversation(
					{ fetchImpl: globalThis.fetch },
					{ server: parsed.server, conversationId },
				);
				process.stdout.write(`Signaled frontend to open ${conversationId}\n`);
			}

			for await (const event of events) {
				const rendered = renderEvent(event, { showReasoning: parsed.showReasoning });
				if (rendered?.stdout) process.stdout.write(rendered.stdout);
				if (rendered?.stderr) process.stderr.write(rendered.stderr);
			}

			if (conversationId) {
				process.stdout.write(`\n[conversation] ${conversationId}\n`);
			}
			break;
		}
	}
}

main().catch((err: unknown) => {
	process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
