import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	it("does not crash when params are the wrong type (model hallucination)", async () => {
		const tool = createSearchCodeTool(workDir);
		// A non-string query must be rejected gracefully, not throw.
		const q = await tool.execute({ query: ["a", "b"] as unknown as string });
		expect(q).toMatch(/^Error:/);
		expect(q).toContain("query is required");
		// A non-string include_ext (array) must not throw "x.trim is not a function".
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = "null";
			const out = await tool.execute({
				query: "x",
				include_ext: ["ts", "go"] as unknown as string,
				exclude_pattern: { a: 1 } as unknown as string,
			});
			expect(out).toBe("No matches found.");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	it("rejects a path outside the working directory", async () => {
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "anything", path: "../../etc" });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("outside the working directory");
	});

	it("rejects a path that points at a file, not a directory", async () => {
		await writeFileP(join(workDir, "a-file.ts"), "const x = 1;\n");
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "x", path: "a-file.ts" });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("is a file, not a directory");
	});

	it("rejects a path that does not exist", async () => {
		const tool = createSearchCodeTool(workDir);
		const out = await tool.execute({ query: "x", path: "no/such/dir" });
		expect(out).toMatch(/^Error:/);
		expect(out).toContain("does not exist");
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

	it("renders cs 'content'-shape (prose) results instead of a bare header", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			// cs's snippet mode emits `content` + `matchlocations` and no `lines`.
			const csJson = JSON.stringify([
				{
					filename: "notes.md",
					location: join(workDir, "docs/notes.md"),
					score: 0.42,
					language: "Markdown",
					content: "Some heading\nthe orchestration paragraph that matched",
					matchlocations: [[13, 26]],
				},
			]);
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = csJson;
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "orchestration" });
			expect(out).toContain("docs/notes.md [Markdown] (score 0.42)");
			// The snippet text must be present, not a bare header.
			expect(out).toContain("the orchestration paragraph that matched");
			expect(out).not.toContain("no snippet available");
		} finally {
			await rmP(stubDir, { recursive: true, force: true });
		}
	});

	it("truncates an excessively long snippet line", async () => {
		const stubDir = await mkdtempP(join(tmpdir(), "dispatch-cs-stub-"));
		try {
			const longContent = `const x = "${"Z".repeat(5000)}";`;
			const csJson = JSON.stringify([
				{
					filename: "big.ts",
					location: join(workDir, "big.ts"),
					score: 1,
					language: "TypeScript",
					lines: [{ line_number: 1, content: longContent, match_positions: [[10, 14]] }],
				},
			]);
			process.env.DISPATCH_CS_BIN = writeStub(stubDir, ECHO_ENV_STUB);
			process.env.CS_STUB_OUTPUT = csJson;
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "x" });
			expect(out).toContain("line truncated");
			// No single output line should approach the raw 5k length.
			const longest = Math.max(...out.split("\n").map((l) => l.length));
			expect(longest).toBeLessThan(700);
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

		it("renders snippet lines for prose (markdown) matches", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			await writeFileP(
				join(workDir, "doc.md"),
				"# Title\n\nThis paragraph mentions widgetronics in prose.\n",
			);
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "widgetronics" });
			expect(out).toContain("doc.md");
			// The matching prose text must be shown, not just a bare header.
			expect(out).toContain("widgetronics");
			expect(out).not.toContain("no snippet available");
		});

		it("widens the snippet window when context is given", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			const body = Array.from({ length: 21 }, (_, i) => `line ${i + 1}`);
			body[10] = "const findContextTarget = 1;";
			await writeFileP(join(workDir, "ctx.ts"), `${body.join("\n")}\n`);
			const tool = createSearchCodeTool(workDir);
			const countSnippetLines = (s: string) =>
				s.split("\n").filter((l) => /^\s+>?\s*\d+:/.test(l)).length;
			const narrow = await tool.execute({
				query: "findContextTarget",
				context: 0,
				result_limit: 1,
			});
			const wide = await tool.execute({
				query: "findContextTarget",
				context: 6,
				result_limit: 1,
			});
			expect(countSnippetLines(wide)).toBeGreaterThan(countSnippetLines(narrow));
		});

		it("returns 'No matches found.' for a query with no hits", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			await writeFileP(join(workDir, "alpha.ts"), "export const a = 1;\n");
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "zzz_nonexistent_token_qqq" });
			expect(out).toBe("No matches found.");
		});

		it("tags .luau files as Luau", async () => {
			process.env.DISPATCH_CS_BIN = liveCsBin as string;
			await writeFileP(join(workDir, "mod.luau"), "function Mod.doThing()\n\treturn 1\nend\n");
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "doThing" });
			expect(out).toContain("mod.luau");
			expect(out).toContain("[Luau]");
		});
	});

	// ── Luau declaration detection: needs a cs built with the Luau patch
	// (docker/cs/luau-declarations.patch). Skipped on an unpatched/older cs. ──
	const luauCsBin = findLuauCapableCs(liveCsBin);
	describe.runIf(luauCsBin)("live cs binary (Luau declaration patch)", () => {
		// A small Luau module exercising every declaration form the patch adds.
		const LUAU_MODULE = [
			"local Mod = {}",
			"",
			"export type StuntResult = {",
			"\tscore: number,",
			"}",
			"",
			"type LaunchConfig = StuntResult",
			"",
			"function Mod.getDefaults(): LaunchConfig",
			"\treturn { score = 0 }",
			"end",
			"",
			"local function helperThing(x: number): number",
			"\treturn x + 1",
			"end",
			"",
			"Mod.live = Mod.getDefaults()",
			"local used = helperThing(1)",
			"",
		].join("\n");

		beforeEach(async () => {
			process.env.DISPATCH_CS_BIN = luauCsBin as string;
			await writeFileP(join(workDir, "Mod.luau"), LUAU_MODULE);
		});

		it("detects `function Mod.x` declarations in .luau files", async () => {
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "getDefaults", only: "declarations" });
			expect(out).toContain("Mod.luau");
			expect(out).toContain("function Mod.getDefaults");
			expect(out).not.toContain("No matches found");
		});

		it("detects `local function` declarations in .luau files", async () => {
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "helperThing", only: "declarations" });
			expect(out).toContain("Mod.luau");
			expect(out).toContain("local function helperThing");
		});

		it("detects `type` / `export type` declarations in .luau files", async () => {
			const tool = createSearchCodeTool(workDir);
			const exportType = await tool.execute({ query: "StuntResult", only: "declarations" });
			expect(exportType).toContain("export type StuntResult");
			const aliasType = await tool.execute({ query: "LaunchConfig", only: "declarations" });
			expect(aliasType).toContain("type LaunchConfig");
		});

		it("excludes declaration lines when only=usages", async () => {
			const tool = createSearchCodeTool(workDir);
			const out = await tool.execute({ query: "getDefaults", only: "usages" });
			// The call site is a usage; the `function Mod.getDefaults` definition is not.
			expect(out).toContain("Mod.live = Mod.getDefaults()");
			expect(out).not.toContain("function Mod.getDefaults");
		});
	});

	// ── Fuzzy mid-word matching: needs a cs built with the fuzzy patch
	// (docker/cs/fuzzy-distance.patch). Skipped on an unpatched/older cs. ──
	const fuzzyCsBin = findFuzzyCapableCs(liveCsBin);
	describe.runIf(fuzzyCsBin)("live cs binary (fuzzy edit-distance patch)", () => {
		beforeEach(() => {
			process.env.DISPATCH_CS_BIN = fuzzyCsBin as string;
		});

		it("matches a mid-word deletion within distance 1", async () => {
			await writeFileP(
				join(workDir, "phys.ts"),
				"export function computeSlipAngle() {\n\treturn 0;\n}\n",
			);
			const tool = createSearchCodeTool(workDir);
			// "computSlipAngle" drops the 'e' mid-word — edit distance 1.
			const out = await tool.execute({ query: "computSlipAngle~1" });
			expect(out).toContain("phys.ts");
			expect(out).toContain("computeSlipAngle");
			expect(out).not.toBe("No matches found.");
		});

		it("matches a mid-word insertion within distance 1", async () => {
			await writeFileP(join(workDir, "tire.ts"), "const tireFriction = 1;\n");
			const tool = createSearchCodeTool(workDir);
			// "tireFricction" has an extra 'c' — edit distance 1.
			const out = await tool.execute({ query: "tireFricction~1" });
			expect(out).toContain("tire.ts");
			expect(out).toContain("tireFriction");
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

/**
 * Probe a `cs` binary against a throwaway corpus and return its trimmed stdout
 * (or "" on any failure). Used by the capability gates below so patch-dependent
 * live tests run only on a cs that actually has the patch — and skip (not fail)
 * on an unpatched/older binary.
 */
function probeCs(bin: string, files: Record<string, string>, args: string[]): string {
	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), "dispatch-cs-probe-"));
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(join(dir, name), body);
		}
		const res = spawnSync(bin, ["-f", "json", "--dir", dir, ...args], {
			encoding: "utf8",
		});
		if (res.status !== 0 || !res.stdout) return "";
		return res.stdout.trim();
	} catch {
		return "";
	} finally {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Return the cs binary only if it recognises Luau declarations (i.e. was built
 * with docker/cs/luau-declarations.patch): a `--only-declarations` search for a
 * top-level `function` in a .luau file yields a result. Otherwise null → skip.
 */
function findLuauCapableCs(bin: string | null): string | null {
	if (!bin) return null;
	const out = probeCs(bin, { "probe.luau": "function Probe.thing()\n\treturn 1\nend\n" }, [
		"--only-declarations",
		"--",
		"thing",
	]);
	return out !== "" && out !== "null" ? bin : null;
}

/**
 * Return the cs binary only if its fuzzy matcher honours mid-word edits (i.e.
 * was built with docker/cs/fuzzy-distance.patch): a distance-1 deletion matches.
 * Otherwise null → skip.
 */
function findFuzzyCapableCs(bin: string | null): string | null {
	if (!bin) return null;
	const out = probeCs(bin, { "probe.txt": "const x = computeSlipAngle;\n" }, [
		"--",
		"computSlipAngle~1",
	]);
	return out !== "" && out !== "null" ? bin : null;
}
