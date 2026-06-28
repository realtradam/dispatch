import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { buildChatRequest, composeMessage } from "./message.js";

describe("composeMessage", () => {
  it("returns text only", () => {
    expect(composeMessage({ text: "hello" })).toBe("hello");
  });

  it("returns file only with neutral label", () => {
    expect(composeMessage({ file: "foo.txt", fileContent: "contents" })).toBe(
      "Attached file (foo.txt):\ncontents",
    );
  });

  it("returns text + labeled file block", () => {
    expect(composeMessage({ text: "check this", file: "a.ts", fileContent: "const x = 1;" })).toBe(
      "check this\n\nAttached file (a.ts):\nconst x = 1;",
    );
  });

  it("handles missing fileContent gracefully", () => {
    expect(composeMessage({ file: "f.txt" })).toBe("Attached file (f.txt):\n");
  });

  it("uses basename for absolute paths", () => {
    expect(composeMessage({ file: "/tmp/opencode/demo/note.txt", fileContent: "hello" })).toBe(
      "Attached file (note.txt):\nhello",
    );
  });

  it("handles empty input", () => {
    expect(composeMessage({})).toBe("");
  });
});

describe("buildChatRequest", () => {
  it("maps fields correctly", () => {
    const req = buildChatRequest(
      {
        modelName: "cred/model",
        text: "hi",
        showReasoning: false,
      },
      { cwd: "/work", message: "hi" },
    );
    expect(req).toEqual({
      message: "hi",
      model: "cred/model",
      cwd: "/work",
    });
  });

  it("includes conversationId when provided", () => {
    const req = buildChatRequest(
      {
        modelName: "m",
        text: "x",
        conversationId: "conv-123",
        showReasoning: false,
      },
      { cwd: "/work", message: "x" },
    );
    expect(req.conversationId).toBe("conv-123");
  });

  it("omits conversationId when not provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req).not.toHaveProperty("conversationId");
  });

  it("uses explicit cwd over context cwd", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", cwd: "/explicit", showReasoning: false },
      { cwd: "/default", message: "x" },
    );
    expect(req.cwd).toBe("/explicit");
  });

  it("includes reasoningEffort when provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", reasoningEffort: "xhigh", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req.reasoningEffort).toBe("xhigh");
  });

  it("omits reasoningEffort when not provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req).not.toHaveProperty("reasoningEffort");
  });

  it("includes workspaceId when provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", workspaceId: "my-work", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req.workspaceId).toBe("my-work");
  });

  it("omits workspaceId when not provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req).not.toHaveProperty("workspaceId");
  });

  it("includes title when provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", title: "My Task", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req.title).toBe("My Task");
  });

  it("omits title when not provided", () => {
    const req = buildChatRequest(
      { modelName: "m", text: "x", showReasoning: false },
      { cwd: "/work", message: "x" },
    );
    expect(req).not.toHaveProperty("title");
  });
});

describe("workspace flag → ChatRequest", () => {
  const defaultServer = "http://localhost:24203";

  it("--workspace flag sets workspaceId on request", () => {
    const parsed = parseArgs(["my-model", "--text", "hi", "--workspace", "my-work"], {
      defaultServer,
    });
    expect(parsed.kind).toBe("chat");
    if (parsed.kind !== "chat") return;
    const req = buildChatRequest(parsed, { cwd: "/work", message: "hi" });
    expect(req.workspaceId).toBe("my-work");
  });

  it("--workspace flag omitted sends no workspaceId", () => {
    const parsed = parseArgs(["my-model", "--text", "hi"], { defaultServer });
    expect(parsed.kind).toBe("chat");
    if (parsed.kind !== "chat") return;
    const req = buildChatRequest(parsed, { cwd: "/work", message: "hi" });
    expect(req.workspaceId).toBeUndefined();
    expect(req).not.toHaveProperty("workspaceId");
  });

  it("-w shorthand sets workspaceId on request", () => {
    const parsed = parseArgs(["my-model", "--text", "hi", "-w", "shorthand"], {
      defaultServer,
    });
    expect(parsed.kind).toBe("chat");
    if (parsed.kind !== "chat") return;
    const req = buildChatRequest(parsed, { cwd: "/work", message: "hi" });
    expect(req.workspaceId).toBe("shorthand");
  });
});

describe("title flag → ChatRequest", () => {
  const defaultServer = "http://localhost:24203";

  it("--title flag sets title on request", () => {
    const parsed = parseArgs(["my-model", "--text", "hi", "--title", "My Task"], {
      defaultServer,
    });
    expect(parsed.kind).toBe("chat");
    if (parsed.kind !== "chat") return;
    const req = buildChatRequest(parsed, { cwd: "/work", message: "hi" });
    expect(req.title).toBe("My Task");
  });

  it("--title flag omitted sends no title", () => {
    const parsed = parseArgs(["my-model", "--text", "hi"], { defaultServer });
    expect(parsed.kind).toBe("chat");
    if (parsed.kind !== "chat") return;
    const req = buildChatRequest(parsed, { cwd: "/work", message: "hi" });
    expect(req.title).toBeUndefined();
    expect(req).not.toHaveProperty("title");
  });
});
