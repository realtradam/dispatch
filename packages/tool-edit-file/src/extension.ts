import { execBackendHandle } from "@dispatch/exec-backend";
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
		// Host activates exec-backend first → host.getService at activation is safe.
		// LSP stays lazy (looked up at edit time, not activation): the LSP extension
		// activates AFTER us in the CORE_EXTENSIONS array, so resolving it here would
		// throw; the diagnostics hook below defers the lookup to execute().
		dependsOn: ["exec-backend"],
	},
	activate(host) {
		const resolveBackend = host.getService(execBackendHandle);

		// Lazy LSP lookup: the LSP extension activates AFTER us in the
		// CORE_EXTENSIONS array, so host.getService would throw at activation
		// time. Instead, defer the lookup to edit time — by then all extensions
		// have activated. If LSP isn't loaded, the try/catch returns a no-op
		// (graceful degradation: edits proceed without diagnostics).
		const diagnostics: DiagnosticsHook = async (opts) => {
			let lspService: LspService | undefined;
			try {
				lspService = host.getService(lspServiceHandle);
			} catch {
				return { formatted: "", slow: false, timedOut: false };
			}
			if (!lspService) {
				return { formatted: "", slow: false, timedOut: false };
			}
			return lspService.getDiagnostics({
				filePath: opts.filePath,
				text: opts.text,
				cwd: opts.cwd,
				timeoutMs: 60_000,
				minSeverity: 2, // errors + warnings only
			});
		};

		host.defineTool(createEditFileTool({ resolveBackend, workdir: process.cwd(), diagnostics }));
	},
};
