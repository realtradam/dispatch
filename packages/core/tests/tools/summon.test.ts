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
		const tool = createSummonTool(
			"/tmp/work",
			noopCallbacks,
			agents,
			[],
			["/home/u/.config/dispatch/agents"],
		);
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
			[],
			["/home/u/.config/dispatch/agents"],
		);
		expect(tool.description).toContain("No agent definitions are currently defined");
	});

	it("shows two groups when userAgentEnabled is true", () => {
		const subagents: AvailableAgent[] = [
			{
				slug: "programmer",
				name: "Programmer",
				description: "Codes things",
				path: "/agents/programmer.toml",
			},
		];
		const userAgents: AvailableAgent[] = [
			{
				slug: "default",
				name: "Default",
				description: "Default agent",
				path: "/agents/default.toml",
			},
		];
		const tool = createSummonTool(
			"/tmp/work",
			noopCallbacks,
			subagents,
			userAgents,
			["/agents"],
			true,
		);
		expect(tool.description).toContain("Subagents (spawned as child tabs):");
		expect(tool.description).toContain(
			"User agents (spawned as independent top-level tabs, requires top_level=true):",
		);
		expect(tool.description).toContain("programmer");
		expect(tool.description).toContain("default");
	});

	it("hides user agents group when userAgentEnabled is false", () => {
		const subagents: AvailableAgent[] = [
			{
				slug: "programmer",
				name: "Programmer",
				description: "Codes things",
				path: "/agents/programmer.toml",
			},
		];
		const userAgents: AvailableAgent[] = [
			{
				slug: "default",
				name: "Default",
				description: "Default agent",
				path: "/agents/default.toml",
			},
		];
		const tool = createSummonTool(
			"/tmp/work",
			noopCallbacks,
			subagents,
			userAgents,
			["/agents"],
			false,
		);
		expect(tool.description).toContain("Available agents:");
		expect(tool.description).not.toContain("User agents");
		// "default" appears in generic description text, so check for the slug listing format
		expect(tool.description).not.toContain("- default: Default");
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

	it("returns spawned agent_id when background=true (no blocking on result)", async () => {
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "should-not-see" }));
		const tool = createSummonTool("/tmp/work", { spawn: async () => "id-42", getResult }, [], []);
		const out = await tool.execute({ task: "x", agent: "test-agent", background: true });
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
		const out = await tool.execute({ task: "x", agent: "test-agent" });
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
		const out = await tool.execute({ task: "x", agent: "test-agent" });
		expect(out).toContain("boom");
	});

	it("returns fire-and-forget message when top_level=true", async () => {
		const spawn = vi.fn(async () => "ua-tab-1");
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "nope" }));
		const tool = createSummonTool(
			"/tmp/work",
			{ spawn, getResult },
			[],
			[],
			[],
			true, // userAgentEnabled
		);
		const out = await tool.execute({
			task: "do stuff",
			agent: "default",
			top_level: true,
		});
		expect(out).toContain("User agent spawned successfully");
		expect(out).toContain("ua-tab-1");
		expect(out).toContain("fire-and-forget");
		expect(getResult).not.toHaveBeenCalled();

		// Verify topLevel was forwarded to spawn
		const callArg = spawn.mock.calls[0]?.[0];
		expect(callArg).toMatchObject({ topLevel: true });
	});

	it("ignores top_level when userAgentEnabled is false", async () => {
		const spawn = vi.fn(async () => "tab-1");
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "result" }));
		const tool = createSummonTool(
			"/tmp/work",
			{ spawn, getResult },
			[],
			[],
			[],
			false, // userAgentEnabled
		);
		const out = await tool.execute({
			task: "do stuff",
			agent: "default",
			top_level: true, // should be ignored
		});
		// Should behave as a normal foreground summon, not fire-and-forget
		expect(out).not.toContain("fire-and-forget");
		expect(getResult).toHaveBeenCalled();
	});
});

describe("createSummonTool — user-agent-only mode (perm_user_agent without perm_summon)", () => {
	// userAgentEnabled=true, subagentEnabled=false → the tool spawns ONLY
	// top-level user agents. `top_level` is implied (and forced), the
	// subagent/parallel-work prose is dropped, and only the user-agent
	// catalog group is shown.
	const subagents: AvailableAgent[] = [
		{
			slug: "programmer",
			name: "Programmer",
			description: "Codes things",
			path: "/agents/programmer.toml",
		},
	];
	const userAgents: AvailableAgent[] = [
		{
			slug: "default",
			name: "Default",
			description: "Default agent",
			path: "/agents/default.toml",
		},
	];

	function userAgentOnlyTool(
		spawn = vi.fn(async () => "ua-1"),
		getResult = vi.fn(async () => ({ status: "done" as const, result: "nope" })),
	) {
		return {
			spawn,
			getResult,
			tool: createSummonTool(
				"/tmp/work",
				{ spawn, getResult },
				subagents,
				userAgents,
				["/agents"],
				true, // userAgentEnabled
				false, // subagentEnabled
			),
		};
	}

	it("describes spawning user agents and omits subagent/parallel-work prose", () => {
		const { tool } = userAgentOnlyTool();
		expect(tool.description).toContain("Spawn an independent top-level user agent");
		expect(tool.description).toContain("fire-and-forget");
		expect(tool.description).not.toContain("Pattern for parallel work");
		expect(tool.description).not.toContain("Set background=true");
	});

	it("lists only the user-agent catalog group, not subagents", () => {
		const { tool } = userAgentOnlyTool();
		expect(tool.description).toContain("User agents (spawned as independent top-level tabs):");
		expect(tool.description).toContain("default");
		// Subagents must not be advertised in user-agent-only mode.
		expect(tool.description).not.toContain("Subagents (spawned as child tabs):");
		expect(tool.description).not.toContain("- programmer: Programmer");
	});

	it("only lists user-agent slugs in the 'agent' parameter description", () => {
		const { tool } = userAgentOnlyTool();
		const agentParam = (tool.parameters as unknown as { shape: { agent: { description: string } } })
			.shape.agent;
		expect(agentParam.description).toContain("default");
		expect(agentParam.description).not.toContain("programmer");
	});

	it("omits the top_level parameter (it is implied)", () => {
		const { tool } = userAgentOnlyTool();
		const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;
		expect("top_level" in shape).toBe(false);
	});

	it("omits the background parameter (user agents are fire-and-forget)", () => {
		const { tool } = userAgentOnlyTool();
		const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;
		expect("background" in shape).toBe(false);
	});

	it("forces topLevel=true on spawn even when top_level is not passed", async () => {
		const spawn = vi.fn(async () => "ua-99");
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "nope" }));
		const { tool } = userAgentOnlyTool(spawn, getResult);
		const out = await tool.execute({ task: "do stuff", agent: "default" });
		expect(out).toContain("User agent spawned successfully");
		expect(out).toContain("ua-99");
		expect(out).toContain("fire-and-forget");
		// Never blocks on a result for fire-and-forget user agents.
		expect(getResult).not.toHaveBeenCalled();
		const callArg = spawn.mock.calls[0]?.[0];
		expect(callArg).toMatchObject({ topLevel: true, agentSlug: "default" });
	});
});

describe("createSummonTool — subagentEnabled defaults preserve legacy behavior", () => {
	it("defaults subagentEnabled=true so omitting it keeps subagent spawning", async () => {
		const spawn = vi.fn(async () => "tab-1");
		const getResult = vi.fn(async () => ({ status: "done" as const, result: "child" }));
		// No userAgentEnabled/subagentEnabled args → legacy subagent-only mode.
		const tool = createSummonTool("/tmp/work", { spawn, getResult }, [], []);
		const out = await tool.execute({ task: "x", agent: "programmer" });
		// Foreground subagent summon blocks and returns the child result.
		expect(out).toBe("agent_id: tab-1\n\nchild");
		expect(getResult).toHaveBeenCalled();
		const callArg = spawn.mock.calls[0]?.[0];
		expect(callArg).not.toHaveProperty("topLevel");
	});
});
