import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { report as reportDiagnostics } from "../lsp/diagnostic.js";
import type { LspManager } from "../lsp/manager.js";
import type { ResolvedLspServer } from "../lsp/server.js";
import type { ToolDefinition } from "../types/index.js";

const OPERATIONS = ["diagnostics", "hover", "definition", "references", "documentSymbol"] as const;
type Operation = (typeof OPERATIONS)[number];

/**
 * Context the LSP tool needs from the host: the live manager, the tab's
 * effective working directory (used as the LSP `root`), and the servers
 * resolved from that directory's `dispatch.toml`.
 */
export interface LspToolContext {
	manager: LspManager;
	workingDirectory: string;
	servers: ResolvedLspServer[];
}

/**
 * On-demand LSP query tool. Exposes diagnostics plus the navigation
 * capabilities (hover/definition/references/documentSymbol) for a file at a
 * position. Gated behind `perm_lsp` by the host.
 *
 * Coordinates are **1-based** in this tool's API (editor-style, matching what
 * `read_file` shows); they are converted to the LSP wire's 0-based positions
 * before the request.
 */
export function createLspTool(getContext: () => LspToolContext): ToolDefinition {
	return {
		name: "lsp",
		description:
			"Query the configured Language Server (e.g. luau-lsp for Roblox Luau) about a file. " +
			"Operations: 'diagnostics' (type/lint errors for a file), 'hover' (type/docs at a position), " +
			"'definition' (where a symbol is defined), 'references' (all uses of a symbol), " +
			"'documentSymbol' (outline of a file). Line and character are 1-based (as shown in editors). " +
			"Returns JSON. Requires an [lsp] server configured in dispatch.toml that matches the file's extension.",
		parameters: z.object({
			operation: z.enum(OPERATIONS).describe("The LSP operation to perform"),
			path: z.string().describe("Path to the file, relative to the working directory"),
			line: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					"Line number, 1-based (as shown in editors). Required for hover/definition/references.",
				),
			character: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe(
					"Character/column, 1-based (as shown in editors). Required for hover/definition/references.",
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const { manager, workingDirectory, servers } = getContext();
			const operation = args.operation as Operation;
			const pathArg = typeof args.path === "string" ? args.path : "";
			if (!pathArg) return "Error: 'path' is required.";

			const file = isAbsolute(pathArg) ? pathArg : resolve(workingDirectory, pathArg);

			if (servers.length === 0) {
				return "Error: no LSP servers are configured. Add an [lsp] entry to dispatch.toml.";
			}
			if (!manager.hasServerForFile(file, servers)) {
				return `Error: no configured LSP server matches "${pathArg}" (check the server's extensions in dispatch.toml).`;
			}

			// Sync the file so the server has current content, then act.
			await manager.touchFile({ file, root: workingDirectory, servers, mode: "document" });

			if (operation === "diagnostics") {
				const all = manager.getDiagnostics({ root: workingDirectory, servers, file });
				const block = reportDiagnostics(file, all[file] ?? []);
				return block || `No errors reported for ${pathArg}.`;
			}

			if (operation === "documentSymbol") {
				const uri = pathToFileURL(file).href;
				const results = await manager.request({
					file,
					root: workingDirectory,
					servers,
					method: "textDocument/documentSymbol",
					params: { textDocument: { uri } },
				});
				const flat = results.flat().filter(Boolean);
				return flat.length === 0
					? `No symbols found in ${pathArg}.`
					: JSON.stringify(flat, null, 2);
			}

			// Positional operations need line + character.
			const line = typeof args.line === "number" ? Math.floor(args.line) : undefined;
			const character = typeof args.character === "number" ? Math.floor(args.character) : undefined;
			if (line === undefined || character === undefined) {
				return `Error: '${operation}' requires both 'line' and 'character' (1-based).`;
			}

			const uri = pathToFileURL(file).href;
			// Convert editor 1-based → LSP wire 0-based.
			const position = { line: line - 1, character: character - 1 };
			const method =
				operation === "hover"
					? "textDocument/hover"
					: operation === "definition"
						? "textDocument/definition"
						: "textDocument/references";
			const params: Record<string, unknown> = {
				textDocument: { uri },
				position,
				...(operation === "references" ? { context: { includeDeclaration: true } } : {}),
			};

			const results = await manager.request({
				file,
				root: workingDirectory,
				servers,
				method,
				params,
			});
			const flat = results.flat().filter(Boolean);
			return flat.length === 0
				? `No results found for ${operation} at ${pathArg}:${line}:${character}.`
				: JSON.stringify(flat, null, 2);
		},
	};
}
