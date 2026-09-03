import type { ToolContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
  filterRemoteIncompatibleTools,
  gateToolsForWorkspace,
  type ToolAssembly,
} from "./tools-filter.js";

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

// ── Per-workspace tool gate (plan 06 §6.3) ──────────────────────────────────

describe("gateToolsForWorkspace", () => {
  const assembly: ToolAssembly = {
    tools: [
      fakeTool("read_file"), // owned by tool-read-file
      fakeTool("myserver__query"), // MCP-namespaced, injected by mcp
      fakeTool("run_shell"), // owned by tool-shell
    ],
    conversationId: "conv-ws",
    cwd: "/tmp",
    workspaceId: "team-a",
  };
  // The ledger view: every defineTool is tracked under its extension id —
  // including filter-injected MCP tools with runtime names.
  const ledgerOwners: Record<string, string> = {
    read_file: "tool-read-file",
    run_shell: "tool-shell",
    myserver__query: "mcp",
  };
  const ownerOfTool = (name: string) => ledgerOwners[name];

  it("drops tools whose owning plugin is not usable in the workspace (ledger attribution, incl. MCP namespaced)", () => {
    // Only tool-shell is usable in team-a: the MCP-namespaced tool (owned by
    // mcp) and read_file (owned by tool-read-file) are dropped.
    const result = gateToolsForWorkspace(assembly, new Set(["tool-shell"]), ownerOfTool);
    expect(result.tools.map((t) => t.name)).toEqual(["run_shell"]);
  });

  it("keeps the same tool in ANOTHER workspace where its owner is usable", () => {
    const result = gateToolsForWorkspace(
      assembly,
      new Set(["tool-read-file", "tool-shell", "mcp"]),
      ownerOfTool,
    );
    expect(result.tools.map((t) => t.name)).toEqual(["read_file", "myserver__query", "run_shell"]);
  });

  it("fails OPEN for an unattributable tool (no ledger owner)", () => {
    const result = gateToolsForWorkspace(assembly, new Set([]), () => undefined);
    expect(result.tools).toHaveLength(3);
  });

  it("preserves the assembly's non-tool fields verbatim (cwd, conversationId, workspaceId, modelName, signal)", () => {
    const rich: ToolAssembly = {
      ...assembly,
      modelName: "cred/gpt-4",
      computerId: "host",
    };
    const result = gateToolsForWorkspace(rich, new Set(["tool-shell"]), ownerOfTool);
    expect(result).toMatchObject({
      conversationId: "conv-ws",
      cwd: "/tmp",
      workspaceId: "team-a",
      modelName: "cred/gpt-4",
      computerId: "host",
    });
  });
});
