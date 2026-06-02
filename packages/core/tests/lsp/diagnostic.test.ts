import { describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-types";
import { pretty, report } from "../../src/lsp/diagnostic.js";

function diag(partial: Partial<Diagnostic> & { message: string }): Diagnostic {
	return {
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		severity: 1,
		...partial,
	};
}

describe("lsp/diagnostic", () => {
	describe("pretty", () => {
		it("renders 1-based line/col with severity label", () => {
			const out = pretty(
				diag({
					message: "Expected number",
					range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
				}),
			);
			expect(out).toBe("ERROR [5:3] Expected number");
		});

		it("maps severities to labels", () => {
			expect(pretty(diag({ message: "w", severity: 2 }))).toMatch(/^WARN /);
			expect(pretty(diag({ message: "i", severity: 3 }))).toMatch(/^INFO /);
			expect(pretty(diag({ message: "h", severity: 4 }))).toMatch(/^HINT /);
		});

		it("defaults missing severity to ERROR", () => {
			expect(pretty(diag({ message: "x", severity: undefined }))).toMatch(/^ERROR /);
		});
	});

	describe("report", () => {
		it("returns empty string when there are no errors", () => {
			expect(report("a.luau", [])).toBe("");
			// Warnings only → still empty (errors-only).
			expect(report("a.luau", [diag({ message: "w", severity: 2 })])).toBe("");
		});

		it("wraps errors in a <diagnostics file> block", () => {
			const out = report("src/a.luau", [diag({ message: "boom" })]);
			expect(out).toContain('<diagnostics file="src/a.luau">');
			expect(out).toContain("ERROR [1:1] boom");
			expect(out).toContain("</diagnostics>");
		});

		it("filters out non-error severities", () => {
			const out = report("a.luau", [
				diag({ message: "err" }),
				diag({ message: "warn", severity: 2 }),
			]);
			expect(out).toContain("err");
			expect(out).not.toContain("warn");
		});

		it("caps at 20 and notes the remainder", () => {
			const issues = Array.from({ length: 25 }, (_, i) => diag({ message: `e${i}` }));
			const out = report("a.luau", issues);
			expect(out).toContain("... and 5 more");
			expect(out).toContain("e0");
			expect(out).not.toContain("e24");
		});
	});
});
