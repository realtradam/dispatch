import { describe, expect, it } from "vitest";
import { evaluate } from "../../src/permission/evaluate.js";
import type { Ruleset } from "../../src/permission/index.js";

describe("evaluate", () => {
	it("returns default ask when no rules match", () => {
		const result = evaluate("bash", "ls -la");
		expect(result.action).toBe("ask");
		expect(result.permission).toBe("bash");
		expect(result.pattern).toBe("ls -la");
	});

	it("returns allow when matching rule is allow", () => {
		const rules: Ruleset = [{ permission: "bash", pattern: "ls *", action: "allow" }];
		const result = evaluate("bash", "ls -la", rules);
		expect(result.action).toBe("allow");
	});

	it("returns deny when matching rule is deny", () => {
		const rules: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];
		const result = evaluate("bash", "rm -rf /", rules);
		expect(result.action).toBe("deny");
	});

	it("last-match-wins: later deny overrides earlier allow", () => {
		const rules: Ruleset = [
			{ permission: "bash", pattern: "*", action: "allow" },
			{ permission: "bash", pattern: "rm *", action: "deny" },
		];
		const result = evaluate("bash", "rm -rf /", rules);
		expect(result.action).toBe("deny");
	});

	it("last-match-wins: later allow overrides earlier deny", () => {
		const rules: Ruleset = [
			{ permission: "bash", pattern: "rm *", action: "deny" },
			{ permission: "bash", pattern: "*", action: "allow" },
		];
		const result = evaluate("bash", "rm -rf /", rules);
		expect(result.action).toBe("allow");
	});

	it("matches permission wildcard", () => {
		const rules: Ruleset = [{ permission: "*", pattern: "*", action: "allow" }];
		const result = evaluate("read", "anything", rules);
		expect(result.action).toBe("allow");
	});

	it("multiple rulesets are concatenated, last match wins across rulesets", () => {
		const baseRules: Ruleset = [{ permission: "bash", pattern: "*", action: "ask" }];
		const overrideRules: Ruleset = [{ permission: "bash", pattern: "git *", action: "allow" }];
		const result = evaluate("bash", "git status", baseRules, overrideRules);
		expect(result.action).toBe("allow");
	});

	it("second ruleset can deny what first ruleset allows", () => {
		const baseRules: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
		const overrideRules: Ruleset = [{ permission: "bash", pattern: "rm *", action: "deny" }];
		const result = evaluate("bash", "rm -rf /", baseRules, overrideRules);
		expect(result.action).toBe("deny");
	});

	it("non-matching permission returns default ask", () => {
		const rules: Ruleset = [{ permission: "bash", pattern: "*", action: "allow" }];
		const result = evaluate("read", "/some/path", rules);
		expect(result.action).toBe("ask");
	});
});
