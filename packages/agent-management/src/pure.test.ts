/**
 * Pure decision logic tests (constitution: pure core — zero internal mocks,
 * high coverage). Every function in `pure.ts` is (input → output) with no I/O,
 * so these test directly without any `vi.mock`. The service shell is NOT
 * tested here (it's the imperative shell — lenient integration, not pure-unit).
 */

import type { ChatMessage, ConversationMeta } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  clampLimit,
  decideAccess,
  extractLastAssistantReply,
  extractLastError,
  filterByQuery,
  filterByStatus,
  filterModelEntries,
  formatFileAttachments,
  formatListAgentsResult,
  formatListModelsResult,
  formatSummonResult,
  heuristicVisionCapable,
  MIN_SHORT_ID_LEN,
  parseToolAccess,
  resolveShortId,
  resolveVision,
  shortId,
  sortByActivityDesc,
  toAgentEntry,
  truncateText,
} from "./pure.js";
import type { ModelEntry } from "./types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function textMsg(role: ChatMessage["role"], text: string): ChatMessage {
  return { role, chunks: [{ type: "text", text }] };
}
function thinkingMsg(text: string, thinking: string): ChatMessage {
  return {
    role: "assistant",
    chunks: [
      { type: "thinking", text: thinking },
      { type: "text", text },
    ],
  };
}
function errorMsg(message: string): ChatMessage {
  return { role: "assistant", chunks: [{ type: "error", message }] };
}
function meta(id: string, over: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id,
    createdAt: 1,
    lastActivityAt: 1,
    title: "t",
    status: "idle",
    workspaceId: "default",
    ...over,
  };
}

// ─── shortId + resolveShortId ───────────────────────────────────────────────

describe("shortId", () => {
  it("returns the first 8 characters", () => {
    expect(shortId("abcdefghijklmnop")).toBe("abcdefgh");
  });
});

describe("resolveShortId", () => {
  const candidates = ["abcdef123456", "abcdef789012", "zzzzzz999999"];

  it("rejects prefixes shorter than MIN_SHORT_ID_LEN", () => {
    expect(resolveShortId(candidates, "ab").kind).toBe("too-short");
    expect(MIN_SHORT_ID_LEN).toBe(4);
  });

  it("resolves a unique prefix", () => {
    expect(resolveShortId(candidates, "abcdef1")).toEqual({ kind: "unique", id: "abcdef123456" });
  });

  it("resolves a unique full id", () => {
    expect(resolveShortId(candidates, "zzzzzz999999")).toEqual({
      kind: "unique",
      id: "zzzzzz999999",
    });
  });

  it("returns ambiguous when multiple match", () => {
    const res = resolveShortId(candidates, "abcdef");
    expect(res.kind).toBe("ambiguous");
    if (res.kind === "ambiguous") {
      expect(res.candidates).toHaveLength(2);
    }
  });

  it("returns none when nothing matches", () => {
    expect(resolveShortId(candidates, "qqqqqqq").kind).toBe("none");
  });

  it("never leaks candidates outside the authorized set", () => {
    // Only "abcdef123456" is in scope; "zzzz" must NOT match anything here.
    expect(resolveShortId(["abcdef123456"], "zzzz").kind).toBe("none");
  });
});

// ─── extractLastAssistantReply / extractLastError ───────────────────────────

describe("extractLastAssistantReply", () => {
  it("returns the last assistant message's last text chunk", () => {
    const msgs = [
      textMsg("user", "hi"),
      textMsg("assistant", "first"),
      textMsg("assistant", "second"),
    ];
    expect(extractLastAssistantReply(msgs)).toBe("second");
  });

  it("structurally excludes thinking chunks", () => {
    const msgs = [thinkingMsg("the answer", "private reasoning")];
    expect(extractLastAssistantReply(msgs)).toBe("the answer");
  });

  it("returns empty when the last assistant message has only thinking", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", chunks: [{ type: "thinking", text: "hmm" }] },
    ];
    expect(extractLastAssistantReply(msgs)).toBe("");
  });

  it("returns empty when there is no assistant message", () => {
    expect(extractLastAssistantReply([textMsg("user", "hi")])).toBe("");
  });

  it("returns empty when the last assistant message has only tool-call chunks", () => {
    const msgs: ChatMessage[] = [
      {
        role: "assistant",
        chunks: [{ type: "tool-call", toolCallId: "1", toolName: "x", input: {} }],
      },
    ];
    expect(extractLastAssistantReply(msgs)).toBe("");
  });
});

describe("extractLastError", () => {
  it("returns the error message from the last assistant message", () => {
    expect(extractLastError([errorMsg("boom")])).toBe("boom");
  });
  it("returns undefined when no error chunk is present", () => {
    expect(extractLastError([textMsg("assistant", "ok")])).toBeUndefined();
  });
});

// ─── truncateText ───────────────────────────────────────────────────────────

describe("truncateText", () => {
  it("does not truncate when within the cap", () => {
    expect(truncateText("short", 10)).toEqual({ text: "short", truncated: false });
  });
  it("truncates with an ellipsis when over the cap", () => {
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc…", truncated: true });
  });
  it("treats a non-positive cap as no truncation", () => {
    expect(truncateText("abcdef", 0)).toEqual({ text: "abcdef", truncated: false });
  });
});

// ─── vision heuristic ───────────────────────────────────────────────────────

describe("resolveVision", () => {
  it("authoritative ModelInfo.vision wins", () => {
    expect(resolveVision("anything", { id: "x", vision: true })).toBe(true);
    expect(resolveVision("claude-3-sonnet", { id: "x", vision: false })).toBe(false);
  });
  it("falls back to the name heuristic when metadata is absent", () => {
    expect(resolveVision("provider/gpt-4o", undefined)).toBe(true);
    expect(resolveVision("provider/claude-3-opus", undefined)).toBe(true);
    expect(resolveVision("provider/some-text-model", undefined)).toBe(false);
  });
  it("heuristic matches known vision families", () => {
    expect(heuristicVisionCapable("vision-pro")).toBe(true);
    expect(heuristicVisionCapable("kimi-latest")).toBe(true);
    expect(heuristicVisionCapable("gemini-1.5")).toBe(true);
    expect(heuristicVisionCapable("plain-llm")).toBe(false);
  });
});

// ─── filterModelEntries ─────────────────────────────────────────────────────

const ALL_MODELS: ModelEntry[] = [
  { name: "a/gpt-4o", vision: true, contextWindow: 128000 },
  { name: "a/text-only", vision: false },
  { name: "b/claude-3", vision: true, displayName: "Claude 3" },
];

describe("filterModelEntries", () => {
  it("preserves catalog order with no filters", () => {
    expect(filterModelEntries(ALL_MODELS, { limit: 10 }).map((m) => m.name)).toEqual([
      "a/gpt-4o",
      "a/text-only",
      "b/claude-3",
    ]);
  });
  it("vision:true keeps only vision models", () => {
    expect(filterModelEntries(ALL_MODELS, { vision: true, limit: 10 }).map((m) => m.name)).toEqual([
      "a/gpt-4o",
      "b/claude-3",
    ]);
  });
  it("vision:false keeps only non-vision models", () => {
    expect(filterModelEntries(ALL_MODELS, { vision: false, limit: 10 }).map((m) => m.name)).toEqual(
      ["a/text-only"],
    );
  });
  it("query filters over name and display name (case-insensitive)", () => {
    expect(
      filterModelEntries(ALL_MODELS, { query: "claude", limit: 10 }).map((m) => m.name),
    ).toEqual(["b/claude-3"]);
    expect(filterModelEntries(ALL_MODELS, { query: "gpt", limit: 10 }).map((m) => m.name)).toEqual([
      "a/gpt-4o",
    ]);
  });
  it("limit caps the result count", () => {
    expect(filterModelEntries(ALL_MODELS, { limit: 1 })).toHaveLength(1);
  });
});

// ─── formatFileAttachments ──────────────────────────────────────────────────

describe("formatFileAttachments", () => {
  it("returns the task unchanged when there are no files", () => {
    expect(formatFileAttachments("do thing", [])).toBe("do thing");
  });
  it("composes labelled, ordered file contents after the task", () => {
    const out = formatFileAttachments("do thing", [
      { path: "a.txt", content: "AAA" },
      { path: "b.txt", content: "BBB" },
    ]);
    expect(out).toContain("do thing");
    expect(out).toContain("--- file: a.txt ---\nAAA");
    expect(out).toContain("--- file: b.txt ---\nBBB");
    // task comes first
    expect(out.indexOf("do thing")).toBeLessThan(out.indexOf("a.txt"));
    expect(out.indexOf("a.txt")).toBeLessThan(out.indexOf("b.txt"));
  });
});

// ─── decideAccess ───────────────────────────────────────────────────────────

describe("decideAccess", () => {
  it("allows descendants for every operation", () => {
    expect(decideAccess("read", { isSelf: false, isDescendant: true }).allowed).toBe(true);
    expect(decideAccess("open", { isSelf: false, isDescendant: true }).allowed).toBe(true);
    expect(decideAccess("mutate", { isSelf: false, isDescendant: true }).allowed).toBe(true);
  });
  it("allows read/open on self", () => {
    expect(decideAccess("read", { isSelf: true, isDescendant: false }).allowed).toBe(true);
    expect(decideAccess("open", { isSelf: true, isDescendant: false }).allowed).toBe(true);
  });
  it("rejects mutate on self (self-steering uses the queue/user-input paths)", () => {
    const r = decideAccess("mutate", { isSelf: true, isDescendant: false });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeDefined();
  });
  it("rejects non-descendant, non-self targets", () => {
    expect(decideAccess("read", { isSelf: false, isDescendant: false }).allowed).toBe(false);
    expect(decideAccess("mutate", { isSelf: false, isDescendant: false }).allowed).toBe(false);
  });
});

// ─── listing helpers ────────────────────────────────────────────────────────

const METAS: ConversationMeta[] = [
  meta("a", { title: "Alpha", lastActivityAt: 3, status: "active" }),
  meta("b", { title: "Beta", lastActivityAt: 1, status: "idle" }),
  meta("c", { title: "Gamma", lastActivityAt: 2, status: "active" }),
];

describe("filterByStatus", () => {
  it("returns all when no filter", () => {
    expect(filterByStatus(METAS, undefined)).toHaveLength(3);
    expect(filterByStatus(METAS, [])).toHaveLength(3);
  });
  it("filters by status set", () => {
    expect(filterByStatus(METAS, ["active"]).map((m) => m.id)).toEqual(["a", "c"]);
  });
});

describe("filterByQuery", () => {
  it("returns all when query is empty", () => {
    expect(filterByQuery(METAS, undefined)).toHaveLength(3);
    expect(filterByQuery(METAS, "  ")).toHaveLength(3);
  });
  it("filters by title substring (case-insensitive)", () => {
    expect(filterByQuery(METAS, "gam").map((m) => m.id)).toEqual(["c"]);
  });
  it("filters by id substring", () => {
    expect(filterByQuery(METAS, "alp").map((m) => m.id)).toEqual(["a"]);
  });
});

describe("sortByActivityDesc", () => {
  it("sorts newest activity first", () => {
    expect(sortByActivityDesc(METAS).map((m) => m.id)).toEqual(["a", "c", "b"]);
  });
  it("does not mutate the input", () => {
    const copy = [...METAS];
    sortByActivityDesc(METAS);
    expect(METAS.map((m) => m.id)).toEqual(copy.map((m) => m.id));
  });
});

describe("toAgentEntry", () => {
  it("builds a concise entry with short id and optional fields", () => {
    const e = toAgentEntry(
      meta("abcdefghijklmnop", { title: "T", status: "active" }),
      "a/model",
      "parentid",
      true,
    );
    expect(e.shortId).toBe("abcdefgh");
    expect(e.manageable).toBe(true);
    expect(e.model).toBe("a/model");
    expect(e.parentConversationId).toBe("parentid");
  });
  it("omits model/parent when null", () => {
    const e = toAgentEntry(meta("abcdefghijklmnop"), null, null, false);
    expect(e.model).toBeUndefined();
    expect(e.parentConversationId).toBeUndefined();
    expect(e.manageable).toBe(false);
  });
});

// ─── clampLimit + parseToolAccess ───────────────────────────────────────────

describe("clampLimit", () => {
  it("defaults when absent or invalid", () => {
    expect(clampLimit(undefined, 20, 100)).toBe(20);
    expect(clampLimit(0, 20, 100)).toBe(20);
    expect(clampLimit(-5, 20, 100)).toBe(20);
    expect(clampLimit(1.5, 20, 100)).toBe(20);
  });
  it("clamps to the max", () => {
    expect(clampLimit(500, 20, 100)).toBe(100);
  });
  it("passes valid values through", () => {
    expect(clampLimit(50, 20, 100)).toBe(50);
  });
});

describe("parseToolAccess", () => {
  it("defaults to all when absent/null", () => {
    expect(parseToolAccess(undefined)).toEqual({ mode: "all" });
    expect(parseToolAccess(null)).toEqual({ mode: "all" });
  });
  it("accepts all/none", () => {
    expect(parseToolAccess("all")).toEqual({ mode: "all" });
    expect(parseToolAccess("none")).toEqual({ mode: "none" });
  });
  it("rejects anything else", () => {
    expect(parseToolAccess("some")).toHaveProperty("error");
    expect(parseToolAccess(42)).toHaveProperty("error");
  });
});

// ─── result formatters ──────────────────────────────────────────────────────

describe("formatters", () => {
  it("formatListModelsResult lists models", () => {
    const s = formatListModelsResult({ models: ALL_MODELS });
    expect(s).toContain("a/gpt-4o");
    expect(s).toContain("vision");
  });
  it("formatListModelsResult handles empty", () => {
    expect(formatListModelsResult({ models: [] })).toContain("No models");
  });
  it("formatSummonResult non-wait is concise", () => {
    const s = formatSummonResult({
      conversationId: "abcdefghijklmnop",
      workspaceId: "ws",
      status: "active",
      started: true,
    });
    expect(s).toContain("abcdefgh");
    expect(s).toContain("active");
  });
  it("formatSummonResult wait with reply", () => {
    const s = formatSummonResult({
      conversationId: "abcdefghijklmnop",
      workspaceId: "ws",
      status: "idle",
      started: true,
      reply: "done",
    });
    expect(s).toContain("done");
  });
  it("formatSummonResult wait timeout notes the agent is still running", () => {
    const s = formatSummonResult({
      conversationId: "abcdefghijklmnop",
      workspaceId: "ws",
      status: "active",
      started: true,
      waitTimeout: true,
    });
    expect(s).toContain("still running");
  });
  it("formatListAgentsResult handles empty + truncation", () => {
    expect(formatListAgentsResult({ agents: [], truncated: false })).toContain("No agents");
    const s = formatListAgentsResult({
      agents: [toAgentEntry(meta("abcdefghijklmnop", { title: "T" }), null, null, true)],
      truncated: true,
    });
    expect(s).toContain("truncated");
  });
});
