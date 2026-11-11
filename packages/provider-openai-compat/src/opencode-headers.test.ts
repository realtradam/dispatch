import { describe, expect, it } from "vitest";
import {
  buildOpenCodeRequestHeaders,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
} from "./opencode-headers.js";

describe("buildOpenCodeRequestHeaders", () => {
  it("sends the conversation id as the session and identifies the client", () => {
    expect(buildOpenCodeRequestHeaders("3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7f8a9b", "fallback")).toEqual(
      {
        "User-Agent": "dispatch/0.1",
        "x-opencode-session": "3f2b8c1e-9a4d-4e7b-8f21-0c5d6e7f8a9b",
      },
    );
    expect(OPENCODE_SESSION_HEADER).toBe("x-opencode-session");
    expect(OPENCODE_USER_AGENT).toBe("dispatch/0.1");
  });

  it("is stable per conversation and distinct across conversations", () => {
    const a1 = buildOpenCodeRequestHeaders("conv-a", "fallback")[OPENCODE_SESSION_HEADER];
    const a2 = buildOpenCodeRequestHeaders("conv-a", "fallback")[OPENCODE_SESSION_HEADER];
    const b = buildOpenCodeRequestHeaders("conv-b", "fallback")[OPENCODE_SESSION_HEADER];
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("always carries a session: falls back when there is no conversation", () => {
    expect(buildOpenCodeRequestHeaders(undefined, "fallback")[OPENCODE_SESSION_HEADER]).toBe(
      "fallback",
    );
  });

  it.each([
    ["empty", ""],
    ["containing a newline (header injection)", "conv\r\nx-injected: 1"],
    ["containing a space", "conv one"],
    ["non-ASCII", "conv-é"],
    ["over 200 characters", "c".repeat(201)],
  ])("falls back for a conversation id that is %s", (_name, conversationId) => {
    expect(buildOpenCodeRequestHeaders(conversationId, "fallback")[OPENCODE_SESSION_HEADER]).toBe(
      "fallback",
    );
  });
});
