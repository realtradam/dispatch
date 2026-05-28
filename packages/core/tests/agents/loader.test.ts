import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandAgentToolNames, getAgentDirPaths, loadAgent } from "../../src/agents/loader.js";

describe("expandAgentToolNames", () => {
	it("expands 'read' into the granular read tools", () => {
		const out = expandAgentToolNames(["read"]);
		expect(out).toContain("read_file");
		expect(out).toContain("read_file_slice");
		expect(out).toContain("list_files");
	});

	it("expands 'edit' into write_file", () => {
		const out = expandAgentToolNames(["edit"]);
		expect(out).toContain("write_file");
	});

	it("expands 'bash' into run_shell", () => {
		const out = expandAgentToolNames(["bash"]);
		expect(out).toContain("run_shell");
	});

	it("passes through non-group tool names unchanged", () => {
		const out = expandAgentToolNames(["summon", "retrieve", "web_search", "youtube_transcribe"]);
		expect(out).toEqual(
			expect.arrayContaining(["summon", "retrieve", "web_search", "youtube_transcribe"]),
		);
	});

	it("always includes 'todo' even when not requested", () => {
		expect(expandAgentToolNames([])).toContain("todo");
		expect(expandAgentToolNames(["read"])).toContain("todo");
		expect(expandAgentToolNames(["summon"])).toContain("todo");
	});

	it("deduplicates when groups overlap with explicit names", () => {
		const out = expandAgentToolNames(["read", "read_file"]);
		// Each name should appear at most once
		const counts = new Map<string, number>();
		for (const t of out) counts.set(t, (counts.get(t) ?? 0) + 1);
		for (const [, c] of counts) expect(c).toBe(1);
	});
});

describe("getAgentDirPaths", () => {
	it("returns just the global dir when no projectDir is supplied", () => {
		const paths = getAgentDirPaths();
		expect(paths).toHaveLength(1);
		expect(paths[0]).toContain(".config/dispatch/agents");
	});

	it("appends the project-scoped dir when projectDir is supplied", () => {
		const paths = getAgentDirPaths("/some/project");
		expect(paths).toHaveLength(2);
		expect(paths[1]).toBe("/some/project/.dispatch/agents");
	});
});

describe("loadAgent — project-scoped sandbox", () => {
	// `GLOBAL_AGENTS_DIR` is captured at module load via `os.homedir()`
	// and can't be redirected at runtime. The project-scoped path,
	// however, is computed per-call from the `projectDir` argument, so
	// we exercise that branch instead. This is also the more common
	// real-world case (per-project agent definitions).
	let tmpProject: string;

	beforeEach(() => {
		tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-loader-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpProject, { recursive: true, force: true });
	});

	function writeAgentToml(slug: string, body: string): void {
		const agentsDir = path.join(tmpProject, ".dispatch", "agents");
		fs.mkdirSync(agentsDir, { recursive: true });
		fs.writeFileSync(path.join(agentsDir, `${slug}.toml`), body, "utf-8");
	}

	// Uses a slug unlikely to collide with anything the user might
	// already have in ~/.config/dispatch/agents. `loadAgent` returns
	// the FIRST match it finds across all scanned directories, and
	// the global scope is scanned before the project scope — a slug
	// that exists in both would resolve to the global one (which is
	// real, not under our control). The "z-dispatch-test-*" prefix
	// gives this fixture exclusive ownership of the slug.
	const TEST_SLUG = "z-dispatch-test-fixture";

	it("returns null for an unknown slug within the project scope", () => {
		const agent = loadAgent("z-dispatch-test-does-not-exist", tmpProject);
		expect(agent).toBeNull();
	});

	it("loads a TOML definition written to the project's .dispatch/agents", () => {
		writeAgentToml(
			TEST_SLUG,
			[
				'name = "Fixture"',
				'description = "Sandbox fixture for loadAgent test."',
				"skills = []",
				'tools = ["read", "bash"]',
				"is_subagent = true",
				"",
				"[[models]]",
				'key_id = "opencode-1"',
				'model_id = "deepseek-v4-flash"',
				"",
			].join("\n"),
		);

		const agent = loadAgent(TEST_SLUG, tmpProject);
		expect(agent).not.toBeNull();
		expect(agent?.slug).toBe(TEST_SLUG);
		expect(agent?.name).toBe("Fixture");
		expect(agent?.tools).toEqual(["read", "bash"]);
		expect(agent?.is_subagent).toBe(true);
		expect(agent?.models).toEqual([{ key_id: "opencode-1", model_id: "deepseek-v4-flash" }]);
		expect(agent?.scope).toBe(tmpProject);
	});

	it("sanitizes the slug so path traversal can't reach outside the agents dir", () => {
		// Even if a caller passes something gnarly, the lookup is by
		// sanitized slug — no file outside the configured dirs should
		// ever be opened. The sanitized form ("etc-passwd") obviously
		// doesn't exist in the temp project, so the result is null.
		const agent = loadAgent("../../../etc/passwd", tmpProject);
		expect(agent).toBeNull();
	});
});
