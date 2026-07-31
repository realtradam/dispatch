/**
 * agent-management extension — the standard extension that exposes the
 * AI-callable tool family for starting and managing agent conversations (plan
 * §3.2, §6). Contributes seven tools and a typed `AgentManagementService`
 * service handle; contributes NO providers.
 *
 * Mirrors the session-orchestrator activation pattern: resolve sibling services
 * through their typed handles, build the service with injected effects, register
 * it via `host.provideService`, and register each tool via `host.defineTool`.
 * Queue operations (send / cancel) route through the session-orchestrator's own
 * `enqueue` / `cancelQueuedMessage` (which resolve the message-queue lazily), so
 * this extension has NO direct dependency on the message-queue extension — the
 * feature degrades off cleanly when it isn't loaded.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import { type AgentManagementDeps, createAgentManagementService } from "./service.js";
import {
  createCancelAgentMessageTool,
  createListAgentModelsTool,
  createListAgentsTool,
  createOpenAgentTool,
  createReadAgentTool,
  createSendAgentMessageTool,
  createSummonAgentTool,
} from "./tools/index.js";
import { agentManagementHandle } from "./types.js";

// ── Bounded config (plan §6: bounded default/max result counts; §9: file
// size limit; §8.2: max wait duration). Injected as deps so tests override them
// and the pure decision logic never reads ambient config. ────────────────────

/** Maximum bytes of a single attached text file (plan §9: reject oversized). */
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
/** Maximum duration a `wait: true` operation blocks (plan §8.2). */
const MAX_WAIT_MS = 120_000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MODEL_LIMIT = 50;
const MAX_MODEL_LIMIT = 200;
const DEFAULT_READ_CHARS = 8000;
const MAX_READ_CHARS = 32000;

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

/**
 * Production text-file reader — the injected filesystem edge (plan §9). Resolves
 * a relative path against `cwd`, enforces working-directory containment, rejects
 * directories / oversized files, and reads UTF-8. Throws on any failure so the
 * service shell can map it to a stable `invalid-input` error. Local only (no
 * `computerId` in the contract); remote file reading is a future concern.
 */
async function readFileContent(filePath: string, cwd: string | undefined): Promise<string> {
  const base = cwd ?? process.cwd();
  const baseAbs = resolvePath(base);
  const resolved = resolvePath(baseAbs, filePath);
  // Working-directory containment: the resolved path must be the base itself or
  // live beneath it. This rejects `..` escapes and absolute paths outside cwd.
  if (resolved !== baseAbs && !resolved.startsWith(`${baseAbs}${sep}`)) {
    throw new Error(`path "${filePath}" escapes the working directory`);
  }
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`"${filePath}" is not a regular file`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`"${filePath}" exceeds the ${MAX_FILE_BYTES}-byte limit`);
  }
  return readFile(resolved, "utf8");
}

export function activate(host: HostAPI): void {
  const conversationStore = host.getService(conversationStoreHandle);
  const credentialStore = host.getService(credentialStoreHandle);

  const deps: AgentManagementDeps = {
    conversationStore,
    credentialStore,
    // Lazily resolve the session-orchestrator. Checked via the activated-
    // manifests list so `host.getService` is only called when the service is
    // registered (mirrors the orchestrator's own lazy `resolveQueue`). The
    // orchestrator owns the idle→startTurn vs active→queue decision and the
    // queued-message cancellation, so this extension never touches the
    // message-queue extension directly.
    resolveOrchestrator: () => {
      const loaded = host.getExtensions().some((m) => m.id === "session-orchestrator");
      return loaded ? host.getService(sessionOrchestratorHandle) : undefined;
    },
    emit: (hook, payload) => host.emit(hook, payload),
    readFileContent,
    generateId: () => crypto.randomUUID(),
    logger: host.logger,
    // ── bounds ──
    maxWaitMs: MAX_WAIT_MS,
    defaultListLimit: DEFAULT_LIST_LIMIT,
    maxListLimit: MAX_LIST_LIMIT,
    defaultModelLimit: DEFAULT_MODEL_LIMIT,
    maxModelLimit: MAX_MODEL_LIMIT,
    maxFileBytes: MAX_FILE_BYTES,
    defaultReadChars: DEFAULT_READ_CHARS,
    maxReadChars: MAX_READ_CHARS,
  };

  const service = createAgentManagementService(deps);

  host.provideService(agentManagementHandle, service);

  // Register the seven AI-callable tools (plan §6). Each is a thin shell that
  // parses args, pulls the caller conversation id from ToolExecuteContext, calls
  // the typed service, and formats the result. Mutating tools are not
  // concurrency-safe (plan §8.4) — the tool contracts declare that themselves.
  host.defineTool(createListAgentModelsTool(service));
  host.defineTool(createSummonAgentTool(service));
  host.defineTool(createListAgentsTool(service));
  host.defineTool(createReadAgentTool(service));
  host.defineTool(createSendAgentMessageTool(service));
  host.defineTool(createCancelAgentMessageTool(service));
  host.defineTool(createOpenAgentTool(service));

  host.logger.info("agent-management: activated");
}

export const extension: Extension = {
  manifest,
  activate,
};
