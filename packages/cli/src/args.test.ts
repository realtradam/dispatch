import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

const defaultServer = "http://localhost:24203";

describe("parseArgs", () => {
	it("returns help for empty argv", () => {
		expect(parseArgs([], { defaultServer })).toEqual({ kind: "help" });
	});

	it("returns help for --help", () => {
		expect(parseArgs(["--help"], { defaultServer })).toEqual({ kind: "help" });
	});

	it("returns help for -h", () => {
		expect(parseArgs(["-h"], { defaultServer })).toEqual({ kind: "help" });
	});

	describe("models", () => {
		it("parses 'models' with default server", () => {
			expect(parseArgs(["models"], { defaultServer })).toEqual({
				kind: "models",
				server: "http://localhost:24203",
			});
		});

		it("parses 'models --server <url>'", () => {
			expect(parseArgs(["models", "--server", "http://example.com"], { defaultServer })).toEqual({
				kind: "models",
				server: "http://example.com",
			});
		});

		it("errors on unknown argument for models", () => {
			const result = parseArgs(["models", "--foo"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("Unknown argument");
		});
	});

	describe("chat", () => {
		it("parses a chat with --text", () => {
			const result = parseArgs(["my-model", "--text", "hello"], { defaultServer });
			expect(result).toEqual({
				kind: "chat",
				server: "http://localhost:24203",
				modelName: "my-model",
				text: "hello",
				file: undefined,
				cwd: undefined,
				conversationId: undefined,
				reasoningEffort: undefined,
				showReasoning: false,
				open: false,
			});
		});

		it("parses a chat with --file", () => {
			const result = parseArgs(["my-model", "--file", "foo.txt"], { defaultServer });
			expect(result).toEqual({
				kind: "chat",
				server: "http://localhost:24203",
				modelName: "my-model",
				text: undefined,
				file: "foo.txt",
				cwd: undefined,
				conversationId: undefined,
				reasoningEffort: undefined,
				showReasoning: false,
				open: false,
			});
		});

		it("parses a chat with both --text and --file", () => {
			const result = parseArgs(["m", "--text", "hi", "--file", "f.txt"], { defaultServer });
			expect(result).toMatchObject({ kind: "chat", text: "hi", file: "f.txt" });
		});

		it("parses --cwd, --conversation, --server, --show-reasoning", () => {
			const result = parseArgs(
				[
					"m",
					"--text",
					"x",
					"--cwd",
					"/tmp",
					"--conversation",
					"abc",
					"--server",
					"http://s",
					"--show-reasoning",
				],
				{ defaultServer },
			);
			expect(result).toEqual({
				kind: "chat",
				server: "http://s",
				modelName: "m",
				text: "x",
				file: undefined,
				cwd: "/tmp",
				conversationId: "abc",
				reasoningEffort: undefined,
				showReasoning: true,
				open: false,
			});
		});

		it("parses --effort high", () => {
			const result = parseArgs(["m", "--text", "x", "--effort", "high"], { defaultServer });
			expect(result).toEqual({
				kind: "chat",
				server: "http://localhost:24203",
				modelName: "m",
				text: "x",
				file: undefined,
				cwd: undefined,
				conversationId: undefined,
				reasoningEffort: "high",
				showReasoning: false,
				open: false,
			});
		});

		it.each(["low", "medium", "high", "xhigh", "max"] as const)("accepts --effort %s", (level) => {
			const result = parseArgs(["m", "--text", "x", "--effort", level], { defaultServer });
			expect(result.kind).toBe("chat");
			if (result.kind === "chat") expect(result.reasoningEffort).toBe(level);
		});

		it("errors when --effort has no value", () => {
			const result = parseArgs(["m", "--text", "x", "--effort"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("--effort requires a value");
		});

		it("errors on invalid effort level", () => {
			const result = parseArgs(["m", "--text", "x", "--effort", "banana"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") {
				expect(result.message).toContain("banana");
				expect(result.message).toContain("low");
				expect(result.message).toContain("medium");
				expect(result.message).toContain("high");
				expect(result.message).toContain("xhigh");
				expect(result.message).toContain("max");
			}
		});

		it("errors when text and file are both missing", () => {
			const result = parseArgs(["my-model"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("--text or --file");
		});

		it("errors on unknown flag", () => {
			const result = parseArgs(["my-model", "--text", "hi", "--bogus"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("Unknown flag");
		});

		it("errors when --text has no value", () => {
			const result = parseArgs(["m", "--text"], { defaultServer });
			expect(result.kind).toBe("error");
		});

		it("errors when --file has no value", () => {
			const result = parseArgs(["m", "--file"], { defaultServer });
			expect(result.kind).toBe("error");
		});

		it("errors when --server has no value", () => {
			const result = parseArgs(["models", "--server"], { defaultServer });
			expect(result.kind).toBe("error");
		});

		it("errors when --cwd has no value", () => {
			const result = parseArgs(["m", "--text", "x", "--cwd"], { defaultServer });
			expect(result.kind).toBe("error");
		});

		it("errors when --conversation has no value", () => {
			const result = parseArgs(["m", "--text", "x", "--conversation"], { defaultServer });
			expect(result.kind).toBe("error");
		});
	});

	describe("list", () => {
		it("parses 'list' with no query", () => {
			expect(parseArgs(["list"], { defaultServer })).toEqual({
				kind: "list",
				server: "http://localhost:24203",
			});
		});

		it("parses 'list' with a query prefix", () => {
			expect(parseArgs(["list", "abc12345"], { defaultServer })).toEqual({
				kind: "list",
				server: "http://localhost:24203",
				query: "abc12345",
			});
		});

		it("parses 'list' with --server after the prefix", () => {
			expect(parseArgs(["list", "abc", "--server", "http://s"], { defaultServer })).toEqual({
				kind: "list",
				server: "http://s",
				query: "abc",
			});
		});

		it("errors on a second positional argument", () => {
			const result = parseArgs(["list", "abc", "def"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("Unexpected argument");
		});

		it("errors on an unknown flag", () => {
			const result = parseArgs(["list", "--bogus"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("Unknown flag");
		});
	});

	describe("read", () => {
		it("parses 'read' with a conversation id", () => {
			expect(parseArgs(["read", "deadbeef"], { defaultServer })).toEqual({
				kind: "read",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
			});
		});

		it("parses 'read' with --server", () => {
			expect(parseArgs(["read", "deadbeef", "--server", "http://s"], { defaultServer })).toEqual({
				kind: "read",
				server: "http://s",
				conversationId: "deadbeef",
			});
		});

		it("errors when no conversation id is given", () => {
			const result = parseArgs(["read"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("conversation id");
		});

		it("errors on a second positional argument", () => {
			const result = parseArgs(["read", "a", "b"], { defaultServer });
			expect(result.kind).toBe("error");
		});
	});

	describe("send", () => {
		it("parses 'send' with --text", () => {
			expect(parseArgs(["send", "deadbeef", "--text", "hi"], { defaultServer })).toEqual({
				kind: "send",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
				text: "hi",
				queue: false,
				open: false,
			});
		});

		it("parses 'send' with --queue", () => {
			const result = parseArgs(["send", "deadbeef", "--text", "hi", "--queue"], {
				defaultServer,
			});
			expect(result).toEqual({
				kind: "send",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
				text: "hi",
				queue: true,
				open: false,
			});
		});

		it("parses 'send' with --open", () => {
			const result = parseArgs(["send", "deadbeef", "--text", "hi", "--open"], {
				defaultServer,
			});
			expect(result).toEqual({
				kind: "send",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
				text: "hi",
				queue: false,
				open: true,
			});
		});

		it("parses 'send' with --cwd and --effort", () => {
			const result = parseArgs(
				["send", "deadbeef", "--text", "hi", "--cwd", "/tmp", "--effort", "xhigh"],
				{ defaultServer },
			);
			expect(result).toEqual({
				kind: "send",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
				text: "hi",
				queue: false,
				open: false,
				cwd: "/tmp",
				reasoningEffort: "xhigh",
			});
		});

		it("requires --text", () => {
			const result = parseArgs(["send", "deadbeef"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("--text");
		});

		it("requires a conversation id", () => {
			const result = parseArgs(["send", "--text", "hi"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("conversation id");
		});

		it("errors when --text has no value", () => {
			const result = parseArgs(["send", "deadbeef", "--text"], { defaultServer });
			expect(result.kind).toBe("error");
		});
	});

	describe("open", () => {
		it("parses 'open' with conversation id", () => {
			expect(parseArgs(["open", "deadbeef"], { defaultServer })).toEqual({
				kind: "open",
				server: "http://localhost:24203",
				conversationId: "deadbeef",
			});
		});

		it("parses 'open' with --server", () => {
			expect(
				parseArgs(["open", "deadbeef", "--server", "http://example.com"], { defaultServer }),
			).toEqual({
				kind: "open",
				server: "http://example.com",
				conversationId: "deadbeef",
			});
		});

		it("requires a conversation id", () => {
			const result = parseArgs(["open"], { defaultServer });
			expect(result.kind).toBe("error");
			if (result.kind === "error") expect(result.message).toContain("conversation id");
		});

		it("rejects unknown flags", () => {
			const result = parseArgs(["open", "deadbeef", "--bogus"], { defaultServer });
			expect(result.kind).toBe("error");
		});
	});
});
