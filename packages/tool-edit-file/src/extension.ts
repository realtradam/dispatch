import type { Extension } from "@dispatch/kernel";
import { type LspService, lspServiceHandle } from "@dispatch/lsp";
import { createEditFileTool, type DiagnosticsHook } from "./edit-file.js";

export const extension: Extension = {
	manifest: {
		id: "tool-edit-file",
		name: "Edit File Tool",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { fs: true },
		contributes: { tools: ["edit_file"] },
	},
	activate(host) {
		// Optional LSP integration: if the lsp extension is loaded AND has
		// activated before us, wire its getDiagnostics service as the post-edit
		// diagnostics hook. If absent (not loaded, or activates after us), edits
		// proceed without diagnostics (graceful degradation).
		let lspService: LspService | undefined;
		try {
			lspService = host.getService(lspServiceHandle);
		} catch {
			lspService = undefined;
		}
		const diagnostics: DiagnosticsHook | undefined = lspService
			? async (opts) =>
					lspService.getDiagnostics({
						filePath: opts.filePath,
						text: opts.text,
						cwd: opts.cwd,
						timeoutMs: 60_000,
						minSeverity: 2, // errors + warnings only
					})
			: undefined;

		host.defineTool(createEditFileTool(process.cwd(), diagnostics));
	},
};
