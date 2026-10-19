import { execBackendHandle } from "@dispatch/exec-backend";
import type { Extension } from "@dispatch/kernel";
import { type LspService, lspServiceHandle } from "@dispatch/lsp";
import { createWriteFileTool, type QueueCheckHook } from "./write-file.js";

export const extension: Extension = {
  manifest: {
    id: "tool-write-file",
    name: "Write File Tool",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    tier: "core",
    trust: "bundled",
    activation: "eager",
    capabilities: { fs: true },
    contributes: { tools: ["write_file"] },
    // Core depends only on core (AGENTS.md): exec-backend is the only
    // dependsOn edge. Like tool-edit-file, LSP is a Standard plugin consumed
    // REACTIVELY via the kernel service registry (`tryGetService` at write
    // time) — no core→standard dependency, and the feature degrades off when
    // LSP is absent.
    dependsOn: ["exec-backend"],
  },
  activate(host) {
    const resolveBackend = host.getService(execBackendHandle);

    // Async diagnostics: enqueue a background check per write; returns
    // immediately. Absent LSP → no-op.
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

    host.defineTool(createWriteFileTool({ resolveBackend, workdir: process.cwd(), queueCheck }));
  },
};
