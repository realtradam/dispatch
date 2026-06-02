import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspManager } from "../../src/lsp/manager.js";
import { resolveServersFromConfig } from "../../src/lsp/server.js";

/**
 * Opt-in smoke test against the REAL luau-lsp binary. Skipped automatically
 * (never fails CI) when `luau-lsp` is not on PATH — mirrors opencode's
 * platform-guarded launch test. When the binary IS present, it proves the
 * end-to-end path: spawn → initialize handshake → didOpen → real diagnostics.
 */
function hasLuauLsp(): boolean {
	try {
		execSync("luau-lsp --version", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const RUN = hasLuauLsp();

describe.skipIf(!RUN)("luau-lsp real-binary smoke", () => {
	let root: string;
	let manager: LspManager;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "dispatch-luau-smoke-"));
		manager = new LspManager();
	});
	afterEach(async () => {
		await manager.shutdownAll();
		await rm(root, { recursive: true, force: true });
	});

	it("reports a real type error for a bad .luau file", async () => {
		const servers = resolveServersFromConfig({
			"luau-lsp": {
				command: ["luau-lsp", "lsp"],
				extensions: [".luau"],
				initialization: {
					"luau-lsp": {
						platform: { type: "roblox" },
						diagnostics: { strictDatamodelTypes: false },
					},
				},
			},
		});

		const file = join(root, "bad.luau");
		await writeFile(file, 'local x: number = "not a number"\nprint(x)\n');

		await manager.touchFile({ file, root, servers, mode: "document" });
		const diagnostics = manager.getDiagnostics({ root, servers, file });
		const messages = (diagnostics[file] ?? []).map((d) => d.message).join("\n");

		expect(messages.length).toBeGreaterThan(0);
		expect(messages.toLowerCase()).toContain("number");
	}, 60_000);
});
