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
				showReasoning: false,
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
				showReasoning: false,
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
				showReasoning: true,
			});
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
});
