import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp as mkdtempP, rm as rmP, writeFile as writeFileP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSearchCodeTool } from "../../src/tools/search-code.js";

// A tiny stub that impersonates `cs`: it ignores its args and prints whatever
// JSON we put in the CS_STUB_OUTPUT env var. This makes JSON→text formatting
// tests fully deterministic without needing a real cs binary in CI.
function writeStub(dir: string, body: string): string {
	const stubPath = join(dir, "cs-stub.sh");
	writeFileSync(stubPath, body, { mode: 0o755 });
	chmodSync(stubPath, 0o755);
	return stubPath;
}

const ECHO_ENV_STUB = `#!/usr/bin/env bash
printf '%s' "$CS_STUB_OUTPUT"
`;

// A stub that writes to stderr and exits non-zero, impersonating a cs failure
// (bad flag, invalid regex, etc.).
const FAIL_STUB = `#!/usr/bin/env bash
echo "cs: simulated failure on stderr" >&2
exit 3
`;

describe("search_code tool", () => {
	let workDir: string;
	const savedBin = process.env.DISPATCH_CS_BIN;
	const savedStubOut = process.env.CS_STUB_OUTPUT;

	beforeEach(async () => {
		workDir = await mkdtempP(join(tmpdir(), "dispatch-cs-test-"));
	});

	afterEach(async () => {
		await rmP(workDir, { recursive: true, force: true });
		if (savedBin === undefined) delete process.env.DISPATCH_CS_BIN;
		else process.env.DISPATCH_CS_BIN = savedBin;
		if (savedStubOut === undefined) delete process.env.CS_STUB_OUTPUT;
		else process.env.CS_STUB_OUTPUT = savedStubOut;
	});

	it("exposes the expected name and schema", () => {
		const tool = createSearchCodeTool(workDir);
		expect(tool.name).toBe("search_code");
		expect(tool.description).toContain("cs");
		// query is required; a representative set of optional knobs exist.
		const shape = (tool.parameters as unknown as { shape: Record<string, unknown> }).shape;
		expect(shape.query).toBeDefined();
		expect(shape.path).toBeDefined();
		expect(shape.only).toBeDefined();
		expect(shape.result_limit).toBeDefined();
	});

	it("requires a non-empty query", async () => {
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "   " });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("query is required");
	});

	it("rejects a path outside the working directory", async () => {
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "anything", path: "../../etc" });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("outside the working directory");
	});

	it("returns an actionable error when the cs binary is missing", async () => {
		process.env.DISPATCH_CS_BIN = "/nonexistent/path/to/cs-binary-xyz";
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "anything" });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("requires the 'cs'");
		expect(out).toContain("DISPATCH_CS_BIN");
	});

	it("reports no matches when cs outputs null", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = "null";
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "nothinghere" });
			expect(out).toBe("No matches found.");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	it("formats cs JSON results into readable per-file blocks", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			const csJson = JSON.stringify([
				{
					filename: "web-search.ts",
					location: join(workDir, "packages/core/src/tools/web-search.ts"),
					score: 5.24,
					language: "TypeScript",
					total_lines: 106,
					lines: [
						{ line_number: 7, content: "" },
						{
							line_number: 8,
							content: "export function createWebSearchTool(): ToolDefinition {",
							match_positions: [[16, 35]],
						},
						{ line_number: 9, content: "\treturn {" },
					],
				},
				{
					filename: "index.ts",
					location: join(workDir, "packages/core/src/index.ts"),
					score: 1.1,
					language: "TypeScript",
					lines: [{ line_number: 113, content: 'export { createWebSearchTool } from "./web.js";' }],
				},
			]);
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = csJson;

			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "createWebSearchTool" });

			expect(out).toContain("Found matches in 2 files");
			// Paths are rendered relative to the workdir.
			expect(out).toContain("packages/core/src/tools/web-search.ts [TypeScript] (score 5.24)");
			expect(out).not.toContain(workDir);
			// Matched line is marked with '>'; line numbers + content present.
			expect(out).toContain("> 8: export function createWebSearchTool(): ToolDefinition {");
			expect(out).toContain("  7: ");
			expect(out).toContain("packages/core/src/index.ts [TypeScript] (score 1.10)");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	it("surfaces raw output when cs returns unparseable JSON", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = "this is not json";
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "x" });
			expect(out).toMatch(/^Error:/);
			expect(out).toContain("could not parse cs output");
			expect(out).toContain("this is not json");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	it("reports an error (not 'No matches') when cs exits non-zero", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, FAIL_STUB);
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "x" });
			expect(out).toMatch(/^Error:/);
			expect(out).toContain("exited with code 3");
			// stderr from cs is surfaced to the caller.
			expect(out).toContain("simulated failure on stderr");
			expect(out).not.toContain("No matches found");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	// ── Live integration: only runs when a real `cs` binary is available. ──
	const liveCsBin = findRealCs();
	describe.runIf(liveCsBin)("live cs binary", () => {
		it("finds a real match and ranks the defining file", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			// Seed a small tree with a clear match.
			await writeFileP(
				join(workDir, "alpha.ts"),
				"export function findTheNeedle() {\n  return 42;\n}\n",
			);
			await writeFileP(join(workDir, "beta.ts"), "const x = 1;\n// nothing relevant here\n");
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "findTheNeedle" });
			expect(out).toContain("alpha.ts");
			expect(out).toContain("findTheNeedle");
			expect(out).not.toContain("Error:");
		});

		it("treats a dash-leading query as a search term, not a cs flag", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			// A literal token beginning with '-' must not be parsed as a flag.
			await writeFileP(join(workDir, "dash.ts"), "const dashToken = 1;\n");
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "-dashToken" });
			// Whether or not cs ranks a hit, it must NOT error out on flag parsing.
			expect(out).not.toContain("unknown shorthand flag");
			expect(out).not.toMatch(/^Error: cs exited/);
		});

		it("returns 'No matches found.' for a query with no hits", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			await writeFileP(join(workDir, "alpha.ts"), "export const a = 1;\n");
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "zzz_nonexistent_token_qqq" });
			expect(out).toBe("No matches found.");
		});
	});
});

/**
 * Locate a usable `cs` binary for live tests. Honors DISPATCH_CS_TEST_BIN, then
 * a `cs` on PATH. Returns null when none is runnable, so the live suite is
 * skipped rather than failing in environments without cs.
 */
function findRealCs(): string | null {
	const candidates = [process.env.DISPATCH_CS_TEST_BIN, "cs"].filter(Boolean) as string[];
	for (const bin of candidates) {
		try {
			const res = spawnSync(bin, ["--version"], { stdio: "ignore" });
			if (res.status === 0) return bin;
		} catch {
			// try next
		}
	}
	return null;
}
