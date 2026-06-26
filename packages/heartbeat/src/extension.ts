/**
 * Heartbeat extension — manifest + activate(host).
 *
 * Wires the heartbeat service against the session-orchestrator + a storage
 * namespace, registers the typed service handle, and arms every enabled
 * workspace's scheduler on boot. Prompt templates (`systemPrompt` /
 * `taskPrompt`) are resolved against the SAME variable catalog the global
 * system-prompt template uses (via the system-prompt service's `resolveText`),
 * so `[type:name]` placeholders reach the model substituted — not raw. An empty
 * heartbeat `systemPrompt` inherits the global system prompt template (via
 * `getTemplate`) before variable resolution runs — empty = inherit, not "no
 * system prompt".
 */

import type { ConversationStore } from "@dispatch/conversation-store";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import {
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import type { SystemPromptService } from "@dispatch/system-prompt";
import { systemPromptHandle } from "@dispatch/system-prompt";
import { createHeartbeatService, heartbeatServiceHandle } from "./heartbeat.js";

export const manifest: Manifest = {
  id: "heartbeat",
  name: "Heartbeat",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  // system-prompt provides `resolveText` (the variable resolver used to
  // substitute [type:name] placeholders in heartbeat prompts); conversation-
  // store resolves the workspace's default cwd (the resolver runs git / reads
  // files against it, mirroring the global template). Both lookups are lazy
  // (at fire time, not activation), but declaring them keeps the DAG honest.
  dependsOn: ["session-orchestrator", "system-prompt", "conversation-store"],
  activation: "eager",
  contributes: { services: ["heartbeat"] },
};

// Module-scoped store for deactivate (the extension object is created once).
const store: { service: { stopAll: () => void } | null } = { service: null };

export const extension: Extension = {
  manifest,
  async activate(host: HostAPI) {
    const orchestrator = host.getService<SessionOrchestrator>(sessionOrchestratorHandle);
    const storage = host.storage("heartbeat");
    const logger = host.logger;

    // Resolve [type:name] placeholders in heartbeat prompts via the
    // system-prompt service (same resolver + variables as the global
    // template). The cwd is the workspace's defaultCwd (resolved the same
    // way the orchestrator resolves a new conversation's effective cwd);
    // falling back to process.cwd() when the workspace has none. Both
    // services are declared `dependsOn` (always activated before heartbeat).
    const systemPromptService = host.getService<SystemPromptService>(systemPromptHandle);
    const conversationStore = host.getService<ConversationStore>(conversationStoreHandle);

    const resolvePrompt = async (
      template: string,
      ctx: {
        readonly workspaceId: string;
        readonly conversationId: string;
        readonly model: string;
      },
    ): Promise<string> => {
      const workspace = await conversationStore.getWorkspace(ctx.workspaceId);
      const cwd = workspace?.defaultCwd ?? process.cwd();
      return systemPromptService.resolveText(template, cwd, {
        ...(ctx.conversationId !== "" ? { conversationId: ctx.conversationId } : {}),
        ...(ctx.model !== "" ? { model: ctx.model } : {}),
        workspaceId: ctx.workspaceId,
      });
    };

    const service = createHeartbeatService({
      storage,
      orchestrator,
      logger,
      resolvePrompt,
      // CR-HB-2: an empty heartbeat systemPrompt inherits the global
      // system prompt template (GET /system-prompt / regular
      // conversations resolve) before variable resolution runs.
      getGlobalSystemPrompt: () => systemPromptService.getTemplate(),
      // Pin the heartbeat turn's cwd to the CONFIGURED workspace's
      // defaultCwd (not the heartbeat workspace's empty defaultCwd) so
      // the turn's tools run where the prompt's [prompt:cwd] advertises.
      // Lazy (resolved at fire time, mirroring resolvePrompt).
      getWorkspaceCwd: async (wsId) =>
        (await conversationStore.getWorkspace(wsId))?.defaultCwd ?? null,
    });

    // Reconcile stale runs + arm enabled workspaces on boot.
    await service.startAll();
    store.service = service;

    host.provideService(heartbeatServiceHandle, service);

    host.logger.info("heartbeat extension activated");
  },
  deactivate() {
    // Stop schedulers so no new fires happen during shutdown.
    store.service?.stopAll();
    store.service = null;
  },
};
