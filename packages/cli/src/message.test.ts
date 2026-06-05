import { describe, expect, it } from "vitest";
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
});
