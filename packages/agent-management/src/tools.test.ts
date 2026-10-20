/**
 * Every agent-management tool must declare `concurrencySafe` EXPLICITLY.
 *
 * The kernel dispatcher treats a missing flag as safe, so an unstated flag
 * silently opts a tool into parallelism. With the default maxConcurrent raised
 * to 4 (parallel tool dispatch), that default now matters: a mutating tool
 * must say `false`.
 */

import type { ToolContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { AgentManagementService } from "./service.js";
import {
  createCancelAgentMessageTool,
  createListAgentModelsTool,
  createListAgentsTool,
  createOpenAgentTool,
  createReadAgentTool,
  createSendAgentMessageTool,
  createSummonAgentTool,
} from "./tools/index.js";

/**
 * The factories only CAPTURE the service; these tests never execute a tool.
 * A property access that does happen would throw loudly rather than silently
 * hitting a half-built fake.
 */
const unusedService = new Proxy(
  {},
  {
    get() {
      throw new Error("the service must not be used to inspect tool declarations");
    },
  },
) as unknown as AgentManagementService;

type Factory = (service: AgentManagementService) => ToolContract;

/**
 * The per-tool decision (see the report for the rationale):
 * - read-only listing/reading → true
 * - anything that mutates shared state (queues, conversations) → false
 */
const EXPECTED: ReadonlyArray<readonly [name: string, factory: Factory, safe: boolean]> = [
  ["list_agent_models", createListAgentModelsTool, true],
  ["list_agents", createListAgentsTool, true],
  ["read_agent", createReadAgentTool, true],
  ["open_agent", createOpenAgentTool, true],
  ["summon_agent", createSummonAgentTool, false],
  ["send_agent_message", createSendAgentMessageTool, false],
  ["cancel_agent_message", createCancelAgentMessageTool, false],
];

describe("agent-management tool concurrencySafe declarations", () => {
  for (const [name, factory, safe] of EXPECTED) {
    it(`${name} declares concurrencySafe: ${safe}`, () => {
      const tool = factory(unusedService);
      expect(tool.name).toBe(name);
      expect(tool.concurrencySafe).toBe(safe);
    });
  }

  it("covers every tool exported by the tools barrel", () => {
    expect(EXPECTED).toHaveLength(7);
  });
});

describe("agent-management messaging descriptions", () => {
  for (const factory of [createSendAgentMessageTool, createCancelAgentMessageTool]) {
    it(`${factory(unusedService).name} describes global resolution and self exclusion`, () => {
      const tool = factory(unusedService);
      expect(tool.description).toContain("existing");
      expect(tool.description).toContain("globally unique prefix");
      expect(tool.description).toContain("workspaces");
      expect(tool.description).toContain("yourself");
      const description = tool.parameters.properties?.conversationId?.description;
      expect(description).toContain("globally unique prefix (>=4 chars)");
      expect(description).toContain("except self");
      expect(description).not.toContain("descendant");
    });
  }

  it("list distinguishes metadata scope and unrestricted messaging", () => {
    const tool = createListAgentsTool(unusedService);
    expect(tool.description).toContain("read/open still limited to descendants");
    expect(tool.description).toContain(
      "messaging can target any existing conversation except self",
    );
    expect(tool.description).not.toContain("mutations still limited");
  });
});
