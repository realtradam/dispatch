import { describe, expect, it } from "vitest";
import {
	isPathWithinDir,
	isValidSkillName,
	mergeCatalog,
	parseSkillMeta,
	renderDescription,
	stripLoadedBody,
} from "./pure.js";

describe("parseSkillMeta", () => {
	it("extracts summary when line 2 is ---", () => {
		const content = "Use this for web searches\n---\nBody content here";
		const result = parseSkillMeta(content);
		expect(result.hasMeta).toBe(true);
		expect(result.summary).toBe("Use this for web searches");
	});

	it("extracts summary with trailing whitespace on separator", () => {
		const content = "Summary text\n---   \nBody";
		const result = parseSkillMeta(content);
		expect(result.hasMeta).toBe(true);
		expect(result.summary).toBe("Summary text");
	});

	it("reports no metadata when line 2 is not ---", () => {
		const content = "Some content\nNot a separator\nBody";
		const result = parseSkillMeta(content);
		expect(result.hasMeta).toBe(false);
		expect(result.summary).toBeUndefined();
	});

	it("reports no metadata for single-line content", () => {
		const content = "Only one line";
		const result = parseSkillMeta(content);
		expect(result.hasMeta).toBe(false);
	});

	it("reports no metadata for empty content", () => {
		const result = parseSkillMeta("");
		expect(result.hasMeta).toBe(false);
	});

	it("treats empty summary as undefined", () => {
		const content = "\n---\nBody";
		const result = parseSkillMeta(content);
		expect(result.hasMeta).toBe(true);
		expect(result.summary).toBeUndefined();
	});
});

describe("stripLoadedBody", () => {
	it("removes the first two lines when metadata is present", () => {
		const content = "Summary\n---\nLine 3\nLine 4";
		const result = stripLoadedBody(content, true);
		expect(result).toBe("Line 3\nLine 4");
	});

	it("returns the whole file when malformed", () => {
		const content = "No metadata here\nJust content";
		const result = stripLoadedBody(content, false);
		expect(result).toBe("No metadata here\nJust content");
	});

	it("handles file with only metadata and no body", () => {
		const content = "Summary\n---\n";
		const result = stripLoadedBody(content, true);
		expect(result).toBe("");
	});
});

describe("mergeCatalog", () => {
	it("merges disjoint entries", () => {
		const home = [{ name: "a" }, { name: "b" }];
		const cwd = [{ name: "c" }];
		const result = mergeCatalog(home, cwd);
		expect(result.map((e) => e.name)).toEqual(["a", "b", "c"]);
	});

	it("cwd skill shadows home skill of the same name", () => {
		const home = [{ name: "shared", summary: "home summary" }];
		const cwd = [{ name: "shared", summary: "cwd summary" }];
		const result = mergeCatalog(home, cwd);
		expect(result).toHaveLength(1);
		expect(result[0]?.summary).toBe("cwd summary");
	});

	it("sorts by name", () => {
		const home = [{ name: "z" }, { name: "a" }];
		const cwd = [{ name: "m" }];
		const result = mergeCatalog(home, cwd);
		expect(result.map((e) => e.name)).toEqual(["a", "m", "z"]);
	});

	it("handles empty inputs", () => {
		expect(mergeCatalog([], [])).toEqual([]);
	});
});

describe("renderDescription", () => {
	it("lists all skills by name and appends summaries only for valid ones", () => {
		const catalog = [
			{ name: "web-search", summary: "Use for web searches" },
			{ name: "malformed-skill" },
		];
		const result = renderDescription(catalog);
		expect(result).toBe(
			"Load a skill by name. Available skills:\n- web-search: Use for web searches\n- malformed-skill",
		);
	});

	it("returns a plain message when no skills are available", () => {
		const result = renderDescription([]);
		expect(result).toBe("Load a skill by name. No skills are currently available.");
	});

	it("lists skills with summaries and without", () => {
		const catalog = [
			{ name: "alpha", summary: "First skill" },
			{ name: "beta" },
			{ name: "gamma", summary: "Third skill" },
		];
		const result = renderDescription(catalog);
		expect(result).toContain("- alpha: First skill");
		expect(result).toContain("- beta");
		expect(result).toContain("- gamma: Third skill");
	});
});

describe("isValidSkillName", () => {
	it("accepts a bare skill name", () => {
		expect(isValidSkillName("web-search")).toBe(true);
	});

	it("rejects a name containing /", () => {
		expect(isValidSkillName("../escape")).toBe(false);
	});

	it("rejects a name containing \\", () => {
		expect(isValidSkillName("path\\name")).toBe(false);
	});

	it("rejects a name containing ..", () => {
		expect(isValidSkillName("skill..evil")).toBe(false);
	});

	it("rejects an empty string", () => {
		expect(isValidSkillName("")).toBe(false);
	});

	it("rejects a non-string value", () => {
		expect(isValidSkillName(123)).toBe(false);
		expect(isValidSkillName(null)).toBe(false);
		expect(isValidSkillName(undefined)).toBe(false);
	});
});

describe("isPathWithinDir", () => {
	it("accepts a path within the directory", () => {
		expect(isPathWithinDir("/tmp/base/file.txt", "/tmp/base")).toBe(true);
	});

	it("accepts the directory itself", () => {
		expect(isPathWithinDir("/tmp/base", "/tmp/base")).toBe(true);
	});

	it("rejects a path outside the directory", () => {
		expect(isPathWithinDir("/tmp/other/file.txt", "/tmp/base")).toBe(false);
	});

	it("rejects a prefix attack", () => {
		expect(isPathWithinDir("/tmp/base-evil/file.txt", "/tmp/base")).toBe(false);
	});
});
