/**
 * Composition root — the thin, untested shell that wires everything together.
 *
 * Reads process.argv, reads files, writes to stdout/stderr.
 * This is the ONLY file that touches I/O.
 */

import { readFile } from "node:fs/promises";
import { parseArgs } from "./args.js";
import { formatCatalog } from "./catalog.js";
import { fetchModels, streamChat } from "./http.js";
import { buildChatRequest, composeMessage } from "./message.js";
import { renderEvent } from "./render.js";

const USAGE = `Usage:
  dispatch models [--server <url>]
  dispatch <modelName> --text "..." [--file <path>] [--cwd <dir>] [--conversation <id>] [--server <url>] [--show-reasoning]
  dispatch --help`;

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
