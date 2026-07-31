/**
 * agent-management extension manifest + activation.
 *
 * Contributes the typed {@link AgentManagementService} handle and all 7
 * AI-callable tools. The service delegates to the existing session-orchestrator
 * (start/enqueue/subscribe/cancel) and conversation-store (lineage/policy/
 * context) — it duplicates no orchestration logic. Tools are always visible
 * (no deferred loading). Effects (filesystem, orchestrator, event-bus) live
 * here in the shell, injected into the service; pure decisions live in
 * `pure.ts`. No `console.*`; logging via `host.logger`.
 */

import { readFile as fsReadFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import { type AgentManagementService, agentManagementHandle, createAgentManagementService } from "./service.js";
import {
  createCancelAgentMessageTool,
  createListAgentModelsTool,
  createListAgentsTool,
  createOpenAgentTool,
  createReadAgentTool,
  createSendAgentMessageTool,
  createSummonAgentTool,
} from "./tools/index.js";

export const manifest: Manifest = {
  id: "agent-management",
  name: "Agent Management",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: false },
  dependsOn: ["conversation-store", "credential-store", "session-orchestrator"],
  contributes: {
    services: ["agent-management/service"],
    tools: [
      "list_agent_models",
      "summon_agent",
      "list_agents",
      "read_agent",
      "send_agent_message",
      "cancel_agent_message",
      "open_agent",
    ],
  },
};

/** Max text-file size the `files` attachment will read (512 KiB). */
const MAX_FILE_BYTES = 512 * 1024;

/**
 * Local-filesystem file reader (the shell edge for `files` attachments). Resolves
 * a relative path against `cwd` (or `process.cwd()` when absent), enforces
 * working-directory containment, rejects non-regular files and oversized files,
 * and reads UTF-8. Throws on any error — the service maps that to an
 * `invalid-input` result. Remote-execution backends can replace this injected
 * function later (plan §9); v1 is local-only.
 */
function createReadFileContent(
  maxBytes: number,
): (path: string, cwd: string | undefined) => Promise<string> {
  return async (path, cwd) => {
    const base = cwd ?? process.cwd();
    const abs = isAbsolute(path) ? pathResolve(path) : pathResolve(base, path);
    // Containment: the resolved path must stay under the working directory.
    const rel = relative(base, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`file path escapes the working directory: ${path}`);
    }
    const info = await stat(abs);
    if (!info.isFile()) {
      throw new Error(`not a regular file: ${path}`);
    }
    if (info.size > maxBytes) {
      throw new Error(`file too large (${info.size} bytes > ${maxBytes}): ${path}`);
    }
    return fsReadFile(abs, "utf8");
  };
}

export function activate(host: HostAPI): void {
  const conversationStore = host.getService(conversationStoreHandle);
  const credentialStore = host.getService(credentialStoreHandle);

  const service: AgentManagementService = createAgentManagementService({
    conversationStore,
    credentialStore,
    resolveOrchestrator: () => {
      // Lazily resolve the session-orchestrator. Returns undefined when the
      // extension isn't loaded (feature degrades off — reported as an
      // invalid-input result). Lazy so activation order doesn't matter.
      const loaded = host.getExtensions().some((m) => m.id === "session-orchestrator");
      if (!loaded) return undefined;
      try {
        return host.getService(sessionOrchestratorHandle);
      } catch {
        return undefined;
      }
    },
    emit: (hook, payload) => host.emit(hook, payload),
    readFileContent: createReadFileContent(MAX_FILE_BYTES),
    generateId: () => crypto.randomUUID(),
    logger: host.logger.child({ extensionId: "agent-management" }),
    // ── bounds ──
    maxWaitMs: 120_000,
    defaultListLimit: 20,
    maxListLimit: 100,
    defaultModelLimit: 20,
    maxModelLimit: 100,
    maxFileBytes: MAX_FILE_BYTES,
    defaultReadChars: 4000,
    maxReadChars: 20_000,
  });

  host.provideService(agentManagementHandle, service);

  // Register all 7 tools (always visible — no deferred loading).
  host.defineTool(createListAgentModelsTool(service));
  host.defineTool(createSummonAgentTool(service));
  host.defineTool(createListAgentsTool(service));
  host.defineTool(createReadAgentTool(service));
  host.defineTool(createSendAgentMessageTool(service));
  host.defineTool(createCancelAgentMessageTool(service));
  host.defineTool(createOpenAgentTool(service));

  host.logger.info("agent-management: registered (7 tools + AgentManagementService)");
}

export const extension: Extension = { manifest, activate };
