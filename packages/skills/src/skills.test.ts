import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type ToolExecuteContext } from "@dispatch/kernel";
import type { ToolAssembly } from "@dispatch/session-orchestrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLoadSkillTool, scanSkillsDir } from "./load-skill.js";
import { makeSkillsToolFilter } from "./tools-filter.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  return {
    toolCallId: "test-call-1",
    onOutput: () => {},
    signal: AbortSignal.timeout(5000),
    log: createLogger(
      { extensionId: "test" },
      { emit: () => {} },
      { now: () => 0, newId: () => "id" },
    ),
    ...overrides,
  };
}

let homeDir: string;
let workdir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "skills-home-test-"));
  workdir = await mkdtemp(join(tmpdir(), "skills-workdir-test-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(workdir, { recursive: true, force: true });
});

describe("load_skill tool", () => {
  it("loads a skill body (strips first two lines) from cwd .skills", async () => {
    const skillsDir = join(workdir, ".skills");
    await mkdir(skillsDir);
    await writeFile(
      join(skillsDir, "web-search.md"),
      "Use for web searches\n---\n# Web Search Skill\nDo a web search.",
      "utf8",
    );

    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "web-search" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("# Web Search Skill\nDo a web search.");
  });

  it("falls back to home .skills when not in cwd", async () => {
    const homeSkillsDir = join(homeDir, ".skills");
    await mkdir(homeSkillsDir);
    await writeFile(
      join(homeSkillsDir, "global-skill.md"),
      "Global skill summary\n---\nGlobal body content",
      "utf8",
    );

    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "global-skill" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Global body content");
  });

  it("returns isError for an unknown skill", async () => {
    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "nonexistent" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown skill");
  });

  it("rejects a name containing a path separator", async () => {
    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "../escape" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid skill name");
  });

  it("rejects a name containing ..", async () => {
    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "skill..evil" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid skill name");
  });

  it("rejects a name containing backslash", async () => {
    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "path\\name" }, stubCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Invalid skill name");
  });

  it("returns the whole file when malformed (no --- on line 2)", async () => {
    const skillsDir = join(workdir, ".skills");
    await mkdir(skillsDir);
    await writeFile(
      join(skillsDir, "malformed.md"),
      "Just some content\nNo separator here\nMore content",
      "utf8",
    );

    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "malformed" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Just some content\nNo separator here\nMore content");
  });

  it("cwd skill shadows home skill of the same name", async () => {
    const homeSkillsDir = join(homeDir, ".skills");
    await mkdir(homeSkillsDir);
    await writeFile(join(homeSkillsDir, "shared.md"), "Home summary\n---\nHome body", "utf8");

    const cwdSkillsDir = join(workdir, ".skills");
    await mkdir(cwdSkillsDir);
    await writeFile(join(cwdSkillsDir, "shared.md"), "Cwd summary\n---\nCwd body", "utf8");

    const tool = createLoadSkillTool({ homeDir, workdir });
    const result = await tool.execute({ name: "shared" }, stubCtx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Cwd body");
  });

  it("reads from ctx.cwd when set", async () => {
    const ctxDir = await mkdtemp(join(tmpdir(), "skills-ctx-test-"));
    try {
      const ctxSkillsDir = join(ctxDir, ".skills");
      await mkdir(ctxSkillsDir);
      await writeFile(join(ctxSkillsDir, "ctx-skill.md"), "Ctx summary\n---\nFrom ctx cwd", "utf8");

      const tool = createLoadSkillTool({ homeDir, workdir });
      const result = await tool.execute({ name: "ctx-skill" }, stubCtx({ cwd: ctxDir }));

      expect(result.isError).toBeUndefined();
      expect(result.content).toBe("From ctx cwd");
    } finally {
      await rm(ctxDir, { recursive: true, force: true });
    }
  });

  it("concurrencySafe is true", () => {
    const tool = createLoadSkillTool({ homeDir, workdir });
    expect(tool.concurrencySafe).toBe(true);
  });
});

describe("scanSkillsDir", () => {
  it("scans .md files and parses metadata", async () => {
    const skillsDir = join(workdir, ".skills");
    await mkdir(skillsDir);
    await writeFile(join(skillsDir, "valid.md"), "Summary\n---\nBody", "utf8");
    await writeFile(join(skillsDir, "malformed.md"), "No separator\nBody", "utf8");
    await writeFile(join(skillsDir, "other.txt"), "Not a skill", "utf8");

    const result = await scanSkillsDir(skillsDir);

    expect(result).toHaveLength(2);
    const valid = result.find((e) => e.name === "valid");
    expect(valid?.summary).toBe("Summary");
    const malformed = result.find((e) => e.name === "malformed");
    expect(malformed?.summary).toBeUndefined();
  });

  it("returns empty array for nonexistent directory", async () => {
    const result = await scanSkillsDir(join(workdir, "nonexistent"));
    expect(result).toEqual([]);
  });
});

describe("tools filter", () => {
  it("rewrites load_skill description with the current catalog (cwd-aware)", async () => {
    const homeSkillsDir = join(homeDir, ".skills");
    await mkdir(homeSkillsDir);
    await writeFile(join(homeSkillsDir, "global.md"), "Global summary\n---\nBody", "utf8");

    const cwdSkillsDir = join(workdir, ".skills");
    await mkdir(cwdSkillsDir);
    await writeFile(join(cwdSkillsDir, "local.md"), "Local summary\n---\nBody", "utf8");

    const filter = makeSkillsToolFilter({ homeDir, workdir });

    const tool = createLoadSkillTool({ homeDir, workdir });
    const asm: ToolAssembly = {
      tools: [tool],
      cwd: workdir,
      conversationId: "test-conv",
    };

    const result = await filter(asm);
    const loadSkill = result.tools.find(
      (t: import("@dispatch/kernel").ToolContract) => t.name === "load_skill",
    );
    expect(loadSkill).toBeDefined();
    expect(loadSkill?.description).toContain("global");
    expect(loadSkill?.description).toContain("Global summary");
    expect(loadSkill?.description).toContain("local");
    expect(loadSkill?.description).toContain("Local summary");
  });

  it("updates the name parameter enum with available skills", async () => {
    const cwdSkillsDir = join(workdir, ".skills");
    await mkdir(cwdSkillsDir);
    await writeFile(join(cwdSkillsDir, "alpha.md"), "Alpha\n---\nBody", "utf8");
    await writeFile(join(cwdSkillsDir, "beta.md"), "Beta\n---\nBody", "utf8");

    const filter = makeSkillsToolFilter({ homeDir, workdir });

    const tool = createLoadSkillTool({ homeDir, workdir });
    const asm: ToolAssembly = {
      tools: [tool],
      cwd: workdir,
      conversationId: "test-conv",
    };

    const result = await filter(asm);
    const loadSkill = result.tools.find(
      (t: import("@dispatch/kernel").ToolContract) => t.name === "load_skill",
    );
    expect(loadSkill?.parameters.properties?.name?.enum).toEqual(["alpha", "beta"]);
  });

  it("handles empty skill directories gracefully", async () => {
    const filter = makeSkillsToolFilter({ homeDir, workdir });

    const tool = createLoadSkillTool({ homeDir, workdir });
    const asm: ToolAssembly = {
      tools: [tool],
      cwd: workdir,
      conversationId: "test-conv",
    };

    const result = await filter(asm);
    const loadSkill = result.tools.find(
      (t: import("@dispatch/kernel").ToolContract) => t.name === "load_skill",
    );
    expect(loadSkill?.description).toContain("No skills are currently available");
  });

  it("passes through non-load_skill tools unchanged", async () => {
    const filter = makeSkillsToolFilter({ homeDir, workdir });

    const otherTool = {
      name: "other_tool",
      description: "Some other tool",
      parameters: { type: "object" as const },
      execute: async () => ({ content: "ok" }),
    };
    const asm: ToolAssembly = {
      tools: [otherTool],
      cwd: workdir,
      conversationId: "test-conv",
    };

    const result = await filter(asm);
    expect(result.tools[0]?.name).toBe("other_tool");
    expect(result.tools[0]?.description).toBe("Some other tool");
  });
});
