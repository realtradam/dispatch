import type { ToolContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { filterRemoteIncompatibleTools, type ToolAssembly } from "./tools-filter.js";

function fakeTool(name: string): ToolContract {
  return {
    name,
    description: `Fake tool: ${name}`,
    parameters: { type: "object" },
    execute: async () => ({ content: "ok" }),
  };
}

const baseAssembly: ToolAssembly = {
  tools: [fakeTool("lsp"), fakeTool("mcp__x"), fakeTool("run_shell")],
  conversationId: "conv-1",
};

describe("filterRemoteIncompatibleTools", () => {
  it("REMOTE (computerId set): drops 'lsp' and any '__' namespaced tool, keeps 'run_shell'", () => {
    const remote: ToolAssembly = { ...baseAssembly, computerId: "my-server" };
    const result = filterRemoteIncompatibleTools(remote);
    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain("lsp");
    expect(names).not.toContain("mcp__x");
    expect(names).toContain("run_shell");
    expect(result.tools).toHaveLength(1);
  });

  it("REMOTE: preserves computerId + cwd + conversationId in the returned assembly", () => {
    const remote: ToolAssembly = {
      tools: [fakeTool("lsp"), fakeTool("run_shell")],
      conversationId: "conv-2",
      cwd: "/work",
      computerId: "ssh-host",
    };
    const result = filterRemoteIncompatibleTools(remote);
    expect(result.computerId).toBe("ssh-host");
    expect(result.cwd).toBe("/work");
    expect(result.conversationId).toBe("conv-2");
  });

  it("LOCAL (computerId undefined): passthrough — nothing is dropped", () => {
    const local: ToolAssembly = { ...baseAssembly };
    const result = filterRemoteIncompatibleTools(local);
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("lsp");
    expect(names).toContain("mcp__x");
    expect(names).toContain("run_shell");
  });

  it("LOCAL: returns the exact same assembly object (byte-identical)", () => {
    const local: ToolAssembly = { ...baseAssembly };
    const result = filterRemoteIncompatibleTools(local);
    expect(result).toBe(local);
  });

  it("REMOTE: drops multiple MCP-namespaced tools (serverId__toolName pattern)", () => {
    const remote: ToolAssembly = {
      tools: [
        fakeTool("lsp"),
        fakeTool("filesystem__read"),
        fakeTool("github__create_issue"),
        fakeTool("run_shell"),
        fakeTool("write_file"),
      ],
      conversationId: "conv-3",
      computerId: "host",
    };
    const result = filterRemoteIncompatibleTools(remote);
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(["run_shell", "write_file"]);
  });
});
