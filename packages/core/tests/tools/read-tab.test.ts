import { describe, expect, it } from "vitest";
import { createReadTabTool, type ReadTabCallbacks } from "../../src/tools/read-tab.js";
import type { TabResolution } from "../../src/tools/send-to-tab.js";

function makeCallbacks(overrides: Partial<ReadTabCallbacks> = {}): ReadTabCallbacks {
	return {
		resolveShortId: (): TabResolution => ({
			status: "ok",
			tab: { id: "target-id", title: "Target", handle: "targ" },
		}),
		getLastResponse: () => ({ text: "the answer is 42", status: "idle" }),
		listOpenHandles: () => [{ handle: "targ", title: "Target" }],
		...overrides,
	};
}

describe("createReadTabTool — schema & description", () => {
	it("is a non-blocking snapshot read", () => {
		const tool = createReadTabTool(makeCallbacks());
		expect(tool.name).toBe("read_tab");
		expect(tool.description).toContain("SNAPSHOT");
		expect(tool.description.toLowerCase()).toContain("does not block");
	});
});

describe("createReadTabTool — execute()", () => {
	it("returns the last assistant response wrapped in a tab_response tag", async () => {
		const tool = createReadTabTool(makeCallbacks());
		const out = await tool.execute({ tab_id: "targ" });
		expect(out).toContain("<tab_response");
		expect(out).toContain('tab="targ"');
		expect(out).toContain('status="idle"');
		expect(out).toContain("the answer is 42");
		expect(out).toContain("</tab_response>");
	});

	it("notes that a running tab's response is its previous completed turn", async () => {
		const tool = createReadTabTool(
			makeCallbacks({
				getLastResponse: () => ({ text: "older turn", status: "running" }),
			}),
		);
		const out = await tool.execute({ tab_id: "targ" });
		expect(out).toContain("still running");
		expect(out).toContain("older turn");
	});

	it("explains when a tab has no completed response yet (idle)", async () => {
		const tool = createReadTabTool(
			makeCallbacks({
				getLastResponse: () => ({ text: null, status: "idle" }),
			}),
		);
		const out = await tool.execute({ tab_id: "targ" });
		expect(out).toContain("no completed response");
		expect(out).toContain("no assistant responses yet");
	});

	it("explains when a tab is still on its first turn (running, no prior text)", async () => {
		const tool = createReadTabTool(
			makeCallbacks({
				getLastResponse: () => ({ text: null, status: "running" }),
			}),
		);
		const out = await tool.execute({ tab_id: "targ" });
		expect(out).toContain("no completed response");
		expect(out).toContain("still working on its first turn");
	});

	it("rejects an empty tab_id and lists open handles", async () => {
		const tool = createReadTabTool(makeCallbacks());
		const out = await tool.execute({ tab_id: "" });
		expect(out).toContain("Error");
		expect(out).toContain("targ");
	});

	it("returns a helpful error when the id is unknown", async () => {
		const tool = createReadTabTool(makeCallbacks({ resolveShortId: () => ({ status: "none" }) }));
		const out = await tool.execute({ tab_id: "zzzz" });
		expect(out).toContain("no open tab matches");
		expect(out).toContain("Currently open tabs:");
	});

	it("asks for more characters when the id is ambiguous", async () => {
		const tool = createReadTabTool(
			makeCallbacks({
				resolveShortId: () => ({
					status: "ambiguous",
					matches: [
						{ id: "a1", title: "One", handle: "abcd1" },
						{ id: "a2", title: "Two", handle: "abcd2" },
					],
				}),
			}),
		);
		const out = await tool.execute({ tab_id: "abcd" });
		expect(out).toContain("ambiguous");
		expect(out).toContain("abcd1");
		expect(out).toContain("abcd2");
	});
});
