import { execBackendHandle } from "@dispatch/exec-backend";
import type { Extension } from "@dispatch/kernel";
import { type LspService, lspServiceHandle } from "@dispatch/lsp";
import { createEditFileTool, type QueueCheckHook } from "./edit-file.js";

export const extension: Extension = {
  manifest: {
    id: "tool-edit-file",
    name: "Edit File Tool",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    tier: "core",
    trust: "bundled",
    activation: "eager",
    capabilities: { fs: true },
    contributes: { tools: ["edit_file"] },
    // Core depends only on core (AGENTS.md): exec-backend is the only
    // dependsOn edge. LSP is a Standard plugin consumed REACTIVELY via the
    // kernel service registry — looked up (non-throwing) at edit time, so an
    // lsp loaded/unloaded mid-session is picked up on the next edit with no
    // restart and no core→standard dependency (plan 03).
    dependsOn: ["exec-backend"],
  },
  activate(host) {
    const resolveBackend = host.getService(execBackendHandle);

    // Reactive LSP lookup (plan 03): resolved per edit via the registry's
    // non-throwing `tryGetService`. If LSP isn't loaded (or was unloaded
    // mid-session), the hook degrades to a no-op — edits proceed without
    // background diagnostics.
    //
    // The hook only ENQUEUES a check: it returns immediately, so the edit is
    // never blocked on a language server (plan: lsp-async-diagnostics).
    const queueCheck: QueueCheckHook = (opts) => {
      const lspService: LspService | undefined = host.tryGetService(lspServiceHandle);
      if (lspService === undefined) return;
      lspService.queueCheck({
        conversationId: opts.conversationId,
        filePath: opts.filePath,
        text: opts.text,
        cwd: opts.cwd,
      });
    };

    host.defineTool(createEditFileTool({ resolveBackend, workdir: process.cwd(), queueCheck }));
  },
};
