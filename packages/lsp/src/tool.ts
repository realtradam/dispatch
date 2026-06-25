/**
 * The lsp tool — model-facing tool contract.
 *
 * Operations: diagnostics, hover, definition, references, documentSymbol.
 */

import { extname, resolve } from "node:path";
import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import { aggregateDiagnostics } from "./aggregate.js";
import type { LspManager } from "./manager.js";

type Operation = "diagnostics" | "hover" | "definition" | "references" | "documentSymbol";

const POSITION_OPS: ReadonlySet<string> = new Set(["hover", "definition", "references"]);

interface ValidatedArgs {
	readonly operation: Operation;
	readonly path: string;
	readonly line?: number | undefined;
	readonly character?: number | undefined;
}

function validateArgs(args: unknown): { readonly error: string } | ValidatedArgs {
	if (args === null || args === undefined || typeof args !== "object") {
		return { error: "Error: Arguments must be an object." };
	}
	const obj = args as Record<string, unknown>;

	const rawOp = obj.operation;
	if (typeof rawOp !== "string") {
		return { error: 'Error: Missing "operation" parameter (must be a string).' };
	}
	const validOps: ReadonlySet<string> = new Set([
		"diagnostics",
		"hover",
		"definition",
		"references",
		"documentSymbol",
	]);
	if (!validOps.has(rawOp)) {
		return {
			error: `Error: Invalid operation "${rawOp}". Must be one of: diagnostics, hover, definition, references, documentSymbol.`,
		};
	}
	const operation = rawOp as Operation;

	const rawPath = obj.path;
	if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
		return { error: 'Error: Missing or empty "path" parameter (must be a non-empty string).' };
	}

	let line: number | undefined;
	let character: number | undefined;

	if (obj.line !== undefined) {
		const n = Number(obj.line);
		if (!Number.isFinite(n) || n < 1) {
			return { error: 'Error: Invalid "line" parameter (must be a positive number, 1-based).' };
		}
		line = Math.floor(n);
	}

	if (obj.character !== undefined) {
		const n = Number(obj.character);
		if (!Number.isFinite(n) || n < 1) {
			return {
				error: 'Error: Invalid "character" parameter (must be a positive number, 1-based).',
			};
		}
		character = Math.floor(n);
	}

	const result: ValidatedArgs = { operation, path: rawPath };
	if (line !== undefined) {
		(result as { line?: number }).line = line;
	}
	if (character !== undefined) {
		(result as { character?: number }).character = character;
	}
	return result;
}

function resolveFilePath(filePath: string, cwd: string): string {
	const resolved = resolve(cwd, filePath);
	const normalizedCwd = resolve(cwd);
	if (!resolved.startsWith(normalizedCwd)) {
		return normalizedCwd;
	}
	return resolved;
}

/** Convert validated 1-based line/character to an LSP 0-based position. */
function toPosition(
	line: number | undefined,
	character: number | undefined,
): { readonly line: number; readonly character: number } {
	if (line === undefined || character === undefined) {
		throw new Error("Position operations require both line and character.");
	}
	return { line: line - 1, character: character - 1 };
}

export function createLspTool(manager: LspManager): ToolContract {
	return {
		name: "lsp",
		description:
			"Query language servers for diagnostics, hover information, symbol definitions, references, and document symbols.",
		parameters: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					enum: ["diagnostics", "hover", "definition", "references", "documentSymbol"],
					description: "The LSP operation to perform.",
				},
				path: {
					type: "string",
					description: "File path relative to the workspace.",
				},
				line: {
					type: "number",
					description: "Line number (1-based). Required for hover, definition, references.",
				},
				character: {
					type: "number",
					description: "Character position (1-based). Required for hover, definition, references.",
				},
			},
			required: ["operation", "path"],
		},
		concurrencySafe: true,
		async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
			const validated = validateArgs(args);
			if ("error" in validated) {
				return { content: validated.error, isError: true };
			}

			const { operation, path: filePath, line, character } = validated;
			const cwd = ctx.cwd ?? process.cwd();
			const absolutePath = resolveFilePath(filePath, cwd);

			if (POSITION_OPS.has(operation)) {
				if (line === undefined || character === undefined) {
					return {
						content: `Error: "${operation}" requires both "line" and "character" parameters (1-based).`,
						isError: true,
					};
				}
			}

			try {
				const statuses = await manager.status(cwd);
				if (statuses.length === 0) {
					return { content: "No language server configured for this workspace.", isError: true };
				}

				const fileExt = extname(absolutePath).toLowerCase();

				switch (operation) {
					case "diagnostics": {
						// 10s hard ceiling per server (same policy as the edit path).
						const DIAGNOSTICS_TIMEOUT_MS = 10_000;
						// Query ALL connected servers whose extensions match this file.
						const matching = statuses.filter(
							(s) => s.state === "connected" && s.extensions.some((ext) => ext === fileExt),
						);

						if (matching.length === 0) {
							// No matching server — fall back to any connected server.
							const connected = statuses.find((s) => s.state === "connected");
							if (!connected) {
								const first = statuses[0];
								const detail = first
									? `"${first.name}" is not connected (state: ${first.state})`
									: "is not connected";
								return {
									content: `Language server ${detail}.`,
									isError: true,
								};
							}
							const client = manager.getClient(connected.id, connected.root);
							if (!client) {
								return { content: "Language server client not available.", isError: true };
							}
							const result = await client.waitForDiagnostics(absolutePath, {
								timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
							});
							if (result.timedOut) {
								return {
									content: `⚠️ [${connected.name}] LSP took too long (>10s), diagnostics skipped — please raise this to the user.`,
								};
							}
							return { content: result.formatted || "No diagnostics found." };
						}

						// Query matching servers concurrently, each capped at 10s;
						// a non-responding server is skipped with a notice.
						const agg = await aggregateDiagnostics(
							(id, root) => manager.getClient(id, root),
							matching,
							absolutePath,
							DIAGNOSTICS_TIMEOUT_MS,
							{},
						);
						return { content: agg.formatted || "No diagnostics found." };
					}
					case "hover": {
						const client = await getFirstMatchingClient(manager, statuses, fileExt);
						if (!client) return { content: "No language server available.", isError: true };
						const result = await client.request("textDocument/hover", {
							textDocument: { uri: `file://${absolutePath}` },
							position: toPosition(line, character),
						});
						if (!result) return { content: "No hover information available." };
						const hover = result as { readonly contents?: { readonly value?: string } | string };
						const content =
							typeof hover.contents === "string"
								? hover.contents
								: (hover.contents?.value ?? "No hover information available.");
						return { content };
					}
					case "definition": {
						const client = await getFirstMatchingClient(manager, statuses, fileExt);
						if (!client) return { content: "No language server available.", isError: true };
						const result = await client.request("textDocument/definition", {
							textDocument: { uri: `file://${absolutePath}` },
							position: toPosition(line, character),
						});
						if (!result) return { content: "No definition found." };
						return { content: JSON.stringify(result) };
					}
					case "references": {
						const client = await getFirstMatchingClient(manager, statuses, fileExt);
						if (!client) return { content: "No language server available.", isError: true };
						const result = await client.request("textDocument/references", {
							textDocument: { uri: `file://${absolutePath}` },
							position: toPosition(line, character),
							context: { includeDeclaration: true },
						});
						if (!result) return { content: "No references found." };
						return { content: JSON.stringify(result) };
					}
					case "documentSymbol": {
						const client = await getFirstMatchingClient(manager, statuses, fileExt);
						if (!client) return { content: "No language server available.", isError: true };
						const result = await client.request("textDocument/documentSymbol", {
							textDocument: { uri: `file://${absolutePath}` },
						});
						if (!result) return { content: "No symbols found." };
						return { content: JSON.stringify(result) };
					}
				}
			} catch (err: unknown) {
				return {
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		},
	};
}

/**
 * Find the first connected client whose server claims the file's extension.
 * Falls back to any connected server if no extension match is found.
 * Used by hover/definition/references/documentSymbol (single-server ops).
 */
async function getFirstMatchingClient(
	manager: LspManager,
	statuses: readonly {
		readonly id: string;
		readonly name: string;
		readonly root: string;
		readonly extensions: readonly string[];
		readonly state: string;
	}[],
	fileExt: string,
): Promise<
	{ readonly request: (method: string, params?: unknown) => Promise<unknown> } | undefined
> {
	const matching = statuses.filter(
		(s) => s.state === "connected" && s.extensions.some((ext) => ext === fileExt),
	);
	const target = matching[0] ?? statuses.find((s) => s.state === "connected");
	if (!target) return undefined;
	return manager.getClient(target.id, target.root);
}
