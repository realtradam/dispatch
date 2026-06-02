import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-types";
import { LspManager } from "../../src/lsp/manager.js";
import type { ResolvedLspServer } from "../../src/lsp/server.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixture/lsp/fake-lsp-server.js");

function makeServer(id: string, extensions: string[]) {
	const counter = { count: 0 };
	const server: ResolvedLspServer = {
		id,
		extensions,
		spawn() {
			counter.count += 1;
			const proc = spawn(process.execPath, [FIXTURE], { stdio: "pipe" });
			return { process: proc as never };
		},
	};
	return { server, counter };
}

describe("lsp/manager (fake server)", () => {
	let root: string;
	let manager: LspManager;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "dispatch-lspmgr-"));
		manager = new LspManager();
	});
	afterEach(async () => {
		await manager.shutdownAll();
		await rm(root, { recursive: true, force: true });
	});

	it("hasServerForFile matches by extension", () => {
		const { server } = makeServer("fake", [".luau"]);
		expect(manager.hasServerForFile(join(root, "a.luau"), [server])).toBe(true);
		expect(manager.hasServerForFile(join(root, "a.ts"), [server])).toBe(false);
	});

	it("spawns lazily and reuses the client across calls", async () => {
		const { server, counter } = makeServer("fake", [".luau"]);
		const file = join(root, "a.luau");
		await writeFile(file, "local x = 1\n");

		const c1 = await manager.getClients({ file, root, servers: [server] });
		const c2 = await manager.getClients({ file, root, servers: [server] });
		expect(c1).toHaveLength(1);
		expect(c2).toHaveLength(1);
		expect(c1[0]).toBe(c2[0]);
		expect(counter.count).toBe(1);
	});

	it("does not spawn for a non-matching extension", async () => {
		const { server, counter } = makeServer("fake", [".luau"]);
		const file = join(root, "a.ts");
		await writeFile(file, "const x = 1\n");
		const clients = await manager.getClients({ file, root, servers: [server] });
		expect(clients).toHaveLength(0);
		expect(counter.count).toBe(0);
	});

	it("touchFile + getDiagnostics surfaces a pushed diagnostic", async () => {
		const { server } = makeServer("fake", [".luau"]);
		const file = join(root, "a.luau");
		await writeFile(file, "bad code\n");

		await manager.touchFile({ file, root, servers: [server] });
		const [client] = await manager.getClients({ file, root, servers: [server] });
		// Drive a push through the fake server.
		const diag: Diagnostic = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
			severity: 1,
			message: "manager error",
		};
		await client.connection.sendRequest("test/publish-diagnostics", {
			uri: pathToFileURL(file).href,
			diagnostics: [diag],
		});
		await new Promise((r) => setTimeout(r, 50));

		const result = manager.getDiagnostics({ root, servers: [server], file });
		expect(result[file]?.[0]?.message).toBe("manager error");
	});

	it("request() forwards to clients and flattens results", async () => {
		const { server } = makeServer("fake", [".luau"]);
		const file = join(root, "a.luau");
		await writeFile(file, "local x = 1\n");
		await manager.touchFile({ file, root, servers: [server] });

		const results = await manager.request({
			file,
			root,
			servers: [server],
			method: "textDocument/definition",
			params: {
				textDocument: { uri: pathToFileURL(file).href },
				position: { line: 0, character: 6 },
			},
		});
		expect(results.length).toBeGreaterThan(0);
	});

	it("shutdownAll clears state so the next call respawns", async () => {
		const { server, counter } = makeServer("fake", [".luau"]);
		const file = join(root, "a.luau");
		await writeFile(file, "local x = 1\n");
		await manager.getClients({ file, root, servers: [server] });
		expect(counter.count).toBe(1);
		await manager.shutdownAll();
		await manager.getClients({ file, root, servers: [server] });
		expect(counter.count).toBe(2);
	});
});
