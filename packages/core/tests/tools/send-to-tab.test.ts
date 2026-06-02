import { describe, expect, it, vi } from "vitest";
import {
	createSendToTabTool,
	type SendToTabCallbacks,
	type TabResolution,
} from "../../src/tools/send-to-tab.js";

function makeCallbacks(overrides: Partial<SendToTabCallbacks> = {}): SendToTabCallbacks {
	return {
		resolveShortId: (): TabResolution => ({
			status: "ok",
			tab: { id: "target-id", title: "Target", handle: "targ" },
		}),
		deliver: () => ({ status: "started" }),
		listOpenHandles: () => [{ handle: "targ", title: "Target" }],
		self: { id: "self-id", handle: "self" },
		canReadTab: true,
		...overrides,
	};
}

describe("createSendToTabTool — schema & description", () => {
	it("exposes tab_id and message params and a fire-and-forget description", () => {
		const tool = createSendToTabTool(makeCallbacks());
		expect(tool.name).toBe("send_to_tab");
		expect(tool.description).toContain("fire-and-forget");
		expect(tool.description.toLowerCase()).toContain("queued");
		// Description must steer the model away from busy-waiting for a reply.
		expect(tool.description.toLowerCase()).toContain("do not sleep");
		expect(tool.description.toLowerCase()).toContain("end your turn");
	});

	it("mentions read_tab in the description only when canReadTab is true", () => {
		const tool = createSendToTabTool(makeCallbacks({ canReadTab: true }));
		expect(tool.description).toContain("read_tab");
	});

	it("never mentions read_tab in the description when canReadTab is false", () => {
		const tool = createSendToTabTool(makeCallbacks({ canReadTab: false }));
		expect(tool.description).not.toContain("read_tab");
		// Still tells the agent a reply will wake it + to end its turn.
		expect(tool.description.toLowerCase()).toContain("wake you with a new message");
		expect(tool.description.toLowerCase()).toContain("end your turn");
	});
});

describe("createSendToTabTool — execute()", () => {
	it("delivers to a resolved target and reports the started status", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver }));
		const out = await tool.execute({ tab_id: "targ", message: "hello there" });
		expect(deliver).toHaveBeenCalledTimes(1);
		const [targetId, delivered] = deliver.mock.calls[0] ?? [];
		expect(targetId).toBe("target-id");
		// Provenance header names the sending tab's handle and marks it as a
		// peer agent (not the recipient's own user).
		expect(delivered).toContain("[message from tab self");
		expect(delivered).toContain("another agent");
		expect(delivered).toContain("hello there");
		// Reply contract: the recipient must answer via send_to_tab back to the
		// sender's handle, not as a plain text reply to its own user.
		expect(delivered).toContain('send_to_tab tool with tab_id "self"');
		expect(delivered).toContain("ONLY reply if");
		expect(out).toContain("idle");
		expect(out).toContain("targ");
		// Sender is steered away from busy-waiting and told to end its turn.
		expect(out.toLowerCase()).toContain("do not sleep");
		expect(out.toLowerCase()).toContain("end your turn");
	});

	it("points the sender at read_tab in the result only when canReadTab is true", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver, canReadTab: true }));
		const out = await tool.execute({ tab_id: "targ", message: "hi" });
		expect(out).toContain("read_tab");
	});

	it("omits read_tab from the result when canReadTab is false", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver, canReadTab: false }));
		const out = await tool.execute({ tab_id: "targ", message: "hi" });
		expect(out).not.toContain("read_tab");
		// Still steers away from busy-waiting and toward ending the turn.
		expect(out.toLowerCase()).toContain("do not sleep");
		expect(out.toLowerCase()).toContain("end your turn");
	});

	it("reports the queued status when the target is busy", async () => {
		const deliver = vi.fn(() => ({ status: "queued" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver }));
		const out = await tool.execute({ tab_id: "targ", message: "ping" });
		expect(out.toLowerCase()).toContain("queued");
		expect(out.toLowerCase()).toContain("busy");
	});

	it("reports a HELD message when delivery is suppressed (auto-wake limit hit)", async () => {
		const deliver = vi.fn(() => ({ status: "suppressed" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver }));
		const out = await tool.execute({ tab_id: "targ", message: "ping again" });
		expect(out).toContain("HELD");
		expect(out.toLowerCase()).toContain("limit");
		// It must steer the sender away from retrying in a loop.
		expect(out.toLowerCase()).toContain("do not keep resending");
		expect(out.toLowerCase()).toContain("human");
	});

	it("rejects an empty tab_id and lists open handles", async () => {
		const tool = createSendToTabTool(makeCallbacks());
		const out = await tool.execute({ tab_id: "  ", message: "hi" });
		expect(out).toContain("Error");
		expect(out).toContain("targ");
	});

	it("rejects an empty message", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(makeCallbacks({ deliver }));
		const out = await tool.execute({ tab_id: "targ", message: "   " });
		expect(out).toContain("Error");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("returns a helpful error and open-tab list when the id is unknown", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(
			makeCallbacks({
				resolveShortId: () => ({ status: "none" }),
				deliver,
			}),
		);
		const out = await tool.execute({ tab_id: "zzzz", message: "hi" });
		expect(out).toContain("no open tab matches");
		expect(out).toContain("Currently open tabs:");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("asks for more characters when the id is ambiguous", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(
			makeCallbacks({
				resolveShortId: () => ({
					status: "ambiguous",
					matches: [
						{ id: "a1", title: "One", handle: "abcd1" },
						{ id: "a2", title: "Two", handle: "abcd2" },
					],
				}),
				deliver,
			}),
		);
		const out = await tool.execute({ tab_id: "abcd", message: "hi" });
		expect(out).toContain("ambiguous");
		expect(out).toContain("abcd1");
		expect(out).toContain("abcd2");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("refuses to send to its own tab", async () => {
		const deliver = vi.fn(() => ({ status: "started" as const }));
		const tool = createSendToTabTool(
			makeCallbacks({
				resolveShortId: () => ({
					status: "ok",
					tab: { id: "self-id", title: "Me", handle: "self" },
				}),
				deliver,
			}),
		);
		const out = await tool.execute({ tab_id: "self", message: "hi" });
		expect(out).toContain("cannot send a message to your own tab");
		expect(deliver).not.toHaveBeenCalled();
	});

	it("surfaces a thrown delivery error instead of crashing", async () => {
		const tool = createSendToTabTool(
			makeCallbacks({
				deliver: () => {
					throw new Error("boom");
				},
			}),
		);
		const out = await tool.execute({ tab_id: "targ", message: "hi" });
		expect(out).toContain("Error delivering message");
		expect(out).toContain("boom");
	});
});
