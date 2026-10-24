import { createConversationStore } from "@dispatch/conversation-store";
import {
  type AgentEvent,
  type ChatMessage,
  type ProviderContract,
  type ProviderStreamOptions,
  runTurn,
} from "@dispatch/kernel";
import {
  appendTextFileGuidance,
  createSystemPromptService,
  DEFAULT_TEMPLATE,
  type SystemPromptServiceDeps,
} from "@dispatch/system-prompt";
import { describe, expect, it } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { createCompactionService } from "./compaction.js";
import { createSessionOrchestrator, type SessionOrchestratorDeps } from "./orchestrator.js";
import { createWarmService } from "./warm.js";

const conversationId = "initial-context";
const cwd = "/workspace";
const customTemplate = "Existing custom rules. cwd=[prompt:cwd] workspace=[prompt:workspace_id]";
const legacyPrompt = "Previously resolved custom rules, kept byte-for-byte.\n";
const link = "[Plan](text-file:notes/plan.md)";
const oldHistory: readonly ChatMessage[] = [
  { role: "user", chunks: [{ type: "text", text: "previous question" }] },
  { role: "assistant", chunks: [{ type: "text", text: "previous answer" }] },
];

function expectTextFileGuidance(prompt: string | undefined) {
  expect(prompt).toContain(`\n\n${link}\n\n`);
  expect(prompt).toContain("standalone-paragraph Markdown link");
  expect(prompt).toContain("256 KiB");
  expect(prompt).toContain("BEFORE emitting its reference");
  expect(prompt).toContain("endpoint explicitly rejects conversations with a remote computer");
  expect(prompt).toMatch(/document body is NEVER added to\s+model history/);
  expect(prompt).toMatch(/first and last six source\s+lines/);
  expect(prompt).toContain("Expand shows the full document");
  expect(prompt?.split(link)).toHaveLength(2);
}

function fixture(promptData = new Map<string, string>()) {
  const conversationData = new Map<string, string>();
  const store = createConversationStore(storageFromMap(conversationData));
  const adapters: SystemPromptServiceDeps["adapters"] = {
    fs: { readText: async () => "", exists: async () => false },
    spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    now: () => new Date("2026-10-24T00:00:00Z"),
  };
  const prompt = createSystemPromptService({ storage: storageFromMap(promptData), adapters });
  const requests: Array<{
    messages: readonly ChatMessage[];
    opts: ProviderStreamOptions | undefined;
  }> = [];
  // Only the outermost model boundary is scripted: assembly, turn loop,
  // conversation persistence and system-prompt resolution are all real.
  const provider: ProviderContract = {
    id: "initial-context-provider",
    async *stream(messages, _tools, opts) {
      requests.push({ messages: structuredClone(messages), opts });
      yield { type: "text-delta", delta: link };
      yield { type: "finish", reason: "stop" };
    },
  };
  const deps = {
    conversationStore: store,
    resolveProvider: () => provider,
    resolveSystemPrompt: () => prompt,
    resolveTools: () => [],
    applyToolsFilter: async (
      assembly: Parameters<SessionOrchestratorDeps["applyToolsFilter"]>[0],
    ) => assembly,
    runTurn,
    emit: () => {},
  };
  const { orchestrator, activeConversations } = createSessionOrchestrator(deps);
  const warm = createWarmService(deps, activeConversations);
  async function send(text = "show the saved plan") {
    const events: AgentEvent[] = [];
    await orchestrator.handleMessage({
      conversationId,
      cwd,
      text,
      onEvent: (event) => events.push(event),
    });
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "turn-ended", reason: "sealed" });
  }
  return { store, prompt, promptData, conversationData, requests, deps, warm, send };
}

// Explicitly seed the documented on-disk legacy representation so these tests
// exercise the real service's compatibility reads, not a fake getWithMeta.
function legacyData(storedCwd = cwd, computerId = "") {
  return new Map([
    [`resolved:${conversationId}`, legacyPrompt],
    [`resolved-cwd:${conversationId}`, storedCwd],
    [`resolved-computer:${conversationId}`, computerId],
  ]);
}

describe("actual provider initial-context delivery", () => {
  it.each([
    "default",
    "existing custom",
  ])("delivers mandatory text-file guidance with the %s template through the real turn loop", async (template) => {
    const f = fixture();
    // Set the custom template before the conversation exists, as an upgrade
    // of an existing installation does; default remains genuinely unset.
    if (template === "existing custom") await f.prompt.setTemplate(customTemplate);
    const authoredTemplate = template === "default" ? DEFAULT_TEMPLATE : customTemplate;
    await f.send();

    expect(f.requests).toHaveLength(1);
    const initialSystemPrompt = f.requests[0]?.opts?.systemPrompt;
    expectTextFileGuidance(initialSystemPrompt);
    const resolvedTemplate = await f.prompt.resolveText(authoredTemplate, cwd, {
      conversationId,
      workspaceId: "default",
    });
    expect(initialSystemPrompt).toBe(appendTextFileGuidance(resolvedTemplate));
    if (template === "existing custom") {
      expect(
        initialSystemPrompt?.startsWith(
          "Existing custom rules. cwd=/workspace workspace=default\n\n",
        ),
      ).toBe(true);
    }
    expect(await f.prompt.getTemplate()).toBe(authoredTemplate);
    expect(await f.prompt.get(conversationId)).toBe(initialSystemPrompt);
    expect(await f.prompt.getWithMeta(conversationId)).toEqual({
      prompt: initialSystemPrompt,
      cwd,
      computerId: null,
    });
    expect(f.requests[0]?.messages).toEqual([
      { role: "user", chunks: [{ type: "text", text: "show the saved plan" }] },
    ]);
    // The embed remains a reference in normal history. Neither guidance nor
    // fetched file bodies are injected as conversation messages.
    const history = await f.store.load(conversationId);
    expect(history.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(history[1]?.chunks).toContainEqual(
      expect.objectContaining({ type: "text", text: link }),
    );
    expect(JSON.stringify(history)).not.toContain("Text-file embeds in chat");
  });

  it("keeps an already-resolved legacy prompt exact for warm and continued turns despite template changes", async () => {
    const f = fixture(legacyData());
    await f.prompt.setTemplate(customTemplate);
    await f.store.setCwd(conversationId, cwd);
    await f.store.append(conversationId, oldHistory);
    const before = [...f.promptData];
    const conversationBefore = [...f.conversationData];

    expect(await f.prompt.get(conversationId)).toBe(legacyPrompt);
    expect(await f.warm.warm(conversationId)).not.toHaveProperty("error");
    expect([...f.promptData]).toEqual(before);
    expect([...f.conversationData]).toEqual(conversationBefore);
    await f.send();
    await f.prompt.setTemplate("Changed custom rules. [prompt:cwd]");
    await f.send("continue");

    expect(f.requests.map((request) => request.opts?.systemPrompt)).toEqual([
      legacyPrompt,
      legacyPrompt,
      legacyPrompt,
    ]);
    expect(f.requests[0]?.messages.slice(0, oldHistory.length)).toEqual(oldHistory);
    expect(await f.prompt.get(conversationId)).toBe(legacyPrompt);
    expect(await f.prompt.getWithMeta(conversationId)).toEqual({
      prompt: legacyPrompt,
      cwd,
      computerId: null,
    });
  });

  it.each([
    "missing",
    "cwd",
    "computer",
  ])("warms and reconstructs identical complete custom initial context after %s invalidation without warm writes", async (state) => {
    const f = fixture(
      state === "missing"
        ? new Map()
        : legacyData(
            state === "cwd" ? "/old-workspace" : cwd,
            state === "computer" ? "remote" : "",
          ),
    );
    await f.prompt.setTemplate(customTemplate);
    await f.store.setCwd(conversationId, cwd);
    await f.store.append(conversationId, oldHistory);
    const promptBefore = [...f.promptData];
    const conversationBefore = [...f.conversationData];

    expect(await f.warm.warm(conversationId)).not.toHaveProperty("error");
    expect([...f.promptData]).toEqual(promptBefore);
    expect([...f.conversationData]).toEqual(conversationBefore);
    const warmed = f.requests[0]?.opts?.systemPrompt;
    expectTextFileGuidance(warmed);
    expect(warmed).toBe(
      appendTextFileGuidance("Existing custom rules. cwd=/workspace workspace=default"),
    );
    await f.send();

    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.opts?.systemPrompt).toBe(warmed);
    expect(await f.prompt.get(conversationId)).toBe(warmed);
    expect(await f.prompt.getTemplate()).toBe(customTemplate);
    expect(await f.prompt.getWithMeta(conversationId)).toEqual({
      prompt: warmed,
      cwd,
      computerId: null,
    });
  });

  it("reconstructs legacy custom context on compaction and reuses the complete prompt on the next turn", async () => {
    const f = fixture(legacyData());
    await f.prompt.setTemplate(customTemplate);
    await f.store.setCwd(conversationId, cwd);
    await f.store.append(conversationId, [
      ...oldHistory,
      { role: "user", chunks: [{ type: "text", text: "recent question" }] },
      { role: "assistant", chunks: [{ type: "text", text: "recent answer" }] },
    ]);
    const compaction = createCompactionService({ ...f.deps, emit: () => {} }, new Set());
    const result = await compaction.compact(conversationId, { keepLastN: 2 });
    expect(result).not.toHaveProperty("error");
    const reconstructed = await f.prompt.get(conversationId);
    expectTextFileGuidance(reconstructed ?? undefined);
    expect(f.requests[0]?.opts?.systemPrompt).toContain(
      `${reconstructed}\n\nYou are a conversation summarizer.`,
    );
    expect(await f.prompt.getTemplate()).toBe(customTemplate);

    await f.send();
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1]?.opts?.systemPrompt).toBe(reconstructed);
    expect(f.requests[1]?.opts?.systemPrompt).not.toContain("You are a conversation summarizer.");
  });
});
