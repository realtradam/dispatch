import { describe, expect, it, vi } from "vitest";
import {
	type AvailableAgent,
	createSummonTool,
	type SummonCallbacks,
} from "../../src/tools/summon.js";

const noopCallbacks: SummonCallbacks = {
	spawn: async () => "agent-id-stub",
	getResult: async () => ({ status: "done", result: "" }),
};

describe("createSummonTool — description content", () => {
	it("lists the agent directories so the LLM knows where to look", () => {
		const tool = createSummonTool(
			"/tmp/work",
			noopCallbacks,
			[],
			["/home/u/.config/dispatch/agents", "/tmp/work/.dispatch/agents"],
		);
		expect(tool.description).toContain("/home/u/.config/dispatch/agents");
		expect(tool.description).toContain("/tmp/work/.dispatch/agents");
		expect(tool.description).toContain("read_file");
	});

	it("includes available agent slugs+names in the description", () => {
		const agents: AvailableAgent[] = [
			{
				slug: "programmer",
				name: "Programmer",
				description: "Implements code from a plan.",
				path: "/home/u/.config/dispatch/agents/programmer.toml",
			},
			{
				slug: "researcher",
				name: "Researcher",
				description: "Investigates topics.",
				path: "/home/u/.config/dispatch/agents/researcher.toml",
			},
		];
		const tool = createSummonTool("/tmp/work", noopCallbacks, agents, [
			"/home/u/.config/dispatch/agents",
		]);
		expect(tool.description).toContain("programmer");
		expect(tool.description).toContain("Programmer");
		expect(tool.description).toContain("Implements code from a plan");
		expect(tool.description).toContain("researcher");
		expect(tool.description).toContain("Investigates topics");
	});

	it("emits a 'no agents defined' notice when the catalog is empty", () => {
		const tool = createSummonTool(
			"/tmp/work",
			noopCallbacks,
			[],
			["/home/u/.config/dispatch/agents"],
		);
		expect(tool.description).toContain("No agent definitions are currently defined");
	});
});

describe("createSummonTool — execute() argument forwarding", () => {
	it("forwards agent slug through to callbacks.spawn", async () => {
		const spawn = vi.fn(async () => "tab-xyz");
		const tool = createSummonTool(
			"/tmp/work",
			{ spawn, getResult: async () => ({ status: "done", result: "ok" }) },
			[],
			[],
		);
		await tool.execute({
			task: "do thing",
			agent: "programmer",
			background: true,
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		const callArg = spawn.mock.calls[0]?.[0];
		expect(callArg).toMatchObject({
			task: "do thing",
			agentSlug: "programmer",
		});
	});

	it("omits agentSlug from the spawn payload when no agent param is given", async () => {
		const spawn = vi.fn(async () => "tab-xyz");
		const tool = createSummonTool(
			"/tmp/work",
			{ spawn, getResult: async () => ({ status: "done", result: "ok" }) },
			[],
			[],
		);
		await tool.execute({
			task: "do thing",
			background: true,
		});
		expect(spawn).toHaveBeenCalledTimes(1);
		const callArg = spawn.mock.calls[0]?.[0];
		expect(callArg).not.toHaveProperty("agentSlug");
	});

	it("returns spawned agent_id when background=true (no blocking on result)", async () => {
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "should-not-see" }));
		const tool = createSummonTool("/tmp/work", { spawn: async () => "id-42", getResult }, [], []);
		const out = await tool.execute({ task: "x", background: true });
		expect(out).toContain("id-42");
		// Background mode must not block on getResult
		expect(getResult).not.toHaveBeenCalled();
	});

	it("blocks on result and returns it when background=false (default)", async () => {
		const tool = createSummonTool(
			"/tmp/work",
			{
				spawn: async () => "id-1",
				getResult: async () => ({ status: "done", result: "child-output" }),
			},
			[],
			[],
		);
		const out = await tool.execute({ task: "x" });
		// Foreground summons prefix the blocked result with `agent_id: <id>` so
		// the frontend's ToolCallDisplay regex can surface the "Open Tab" button
		// (see summon.ts). Assert both the prefix and the child output survive.
		expect(out).toContain("agent_id: id-1");
		expect(out).toBe("agent_id: id-1\n\nchild-output");
	});

	it("surfaces child errors when blocking", async () => {
		const tool = createSummonTool(
			"/tmp/work",
			{
				spawn: async () => "id-1",
				getResult: async () => ({ status: "error", error: "boom" }),
			},
			[],
			[],
		);
		const out = await tool.execute({ task: "x" });
		expect(out).toContain("boom");
	});
});
