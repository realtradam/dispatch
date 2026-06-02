import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Diagnostic } from "vscode-languageserver-types";
import { createLspClient, type LspServerHandle } from "../../src/lsp/client.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../fixture/lsp/fake-lsp-server.js");

function spawnFakeServer(): LspServerHandle {
	const proc = spawn(process.execPath, [FIXTURE], { stdio: "pipe" });
	return { process: proc as LspServerHandle["process"] };
}

const ERROR_DIAG: Diagnostic = {
	range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
	severity: 1,
	message: "fake type error",
	source: "Fake",
};

describe("lsp/client (fake server)", () => {
	let workDir: string;

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), "dispatch-lsp-"));
	});
	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true });
	});

	it("completes the initialize handshake and forwards initializationOptions", async () => {
		const handle = spawnFakeServer();
		handle.initialization = { "luau-lsp": { platform: { type: "roblox" } } };
		const client = await createLspClient({
			serverID: "fake",
			server: handle,
			root: workDir,
			directory: workDir,
		});

		const params = await client.connection.sendRequest<{ initializationOptions?: unknown }>(
			"test/get-initialize-params",
			{},
		);
		expect(params.initializationOptions).toEqual({
			"luau-lsp": { platform: { type: "roblox" } },
		});
		await client.shutdown();
	});

	it("opens a file and receives push diagnostics", async () => {
		const handle = spawnFakeServer();
		const client = await createLspClient({
			serverID: "fake",
			server: handle,
			root: workDir,
			directory: workDir,
		});

		const file = join(workDir, "a.luau");
		await writeFile(file, "local x = 1\n");
		const version = await client.notifyOpen(file);
		expect(version).toBe(0);

		// Drive a push from the fake server, then assert it lands in the map.
		await client.connection.sendRequest("test/publish-diagnostics", {
			uri: pathToFileURL(file).href,
			diagnostics: [ERROR_DIAG],
		});
		await new Promise((r) => setTimeout(r, 50));

		expect(client.diagnostics.get(file)?.[0]?.message).toBe("fake type error");
		await client.shutdown();
	});

	it("bumps the document version on re-open (didChange)", async () => {
		const handle = spawnFakeServer();
		const client = await createLspClient({
			serverID: "fake",
			server: handle,
			root: workDir,
			directory: workDir,
		});
		const file = join(workDir, "a.luau");
		await writeFile(file, "local x = 1\n");
		expect(await client.notifyOpen(file)).toBe(0);
		await writeFile(file, "local x = 2\n");
		expect(await client.notifyOpen(file)).toBe(1);

		const lastChange = await client.connection.sendRequest<{ textDocument?: { version?: number } }>(
			"test/get-last-change",
			{},
		);
		expect(lastChange?.textDocument?.version).toBe(1);
		await client.shutdown();
	});

	it("waits for pull diagnostics when the server advertises a diagnostic provider", async () => {
		const handle = spawnFakeServer();
		const client = await createLspClient({
			serverID: "fake",
			server: handle,
			root: workDir,
			directory: workDir,
		});
		// Tell the fake server (before initialize? no — it persists) to answer
		// pull requests. We configure AFTER connect; the static provider flag is
		// read at initialize, so this test exercises the dynamic registration
		// path instead.
		await client.connection.sendRequest("test/configure-pull-diagnostics", {
			registerOn: "didOpen",
			registrations: [{ id: "d1", registerOptions: { identifier: "fake" } }],
			documentDiagnostics: [ERROR_DIAG],
		});

		const file = join(workDir, "a.luau");
		await writeFile(file, "bad\n");
		const version = await client.notifyOpen(file);
		await client.waitForDiagnostics({ path: file, version, mode: "document" });

		expect(client.diagnostics.get(file)?.some((d) => d.message === "fake type error")).toBe(true);
		await client.shutdown();
	});

	it("request() passes through to the server (hover)", async () => {
		const handle = spawnFakeServer();
		const client = await createLspClient({
			serverID: "fake",
			server: handle,
			root: workDir,
			directory: workDir,
		});
		const file = join(workDir, "a.luau");
		await writeFile(file, "local x = 1\n");
		await client.notifyOpen(file);
		const hover = await client.request<{ contents?: { value?: string } }>("textDocument/hover", {
			textDocument: { uri: pathToFileURL(file).href },
			position: { line: 0, character: 6 },
		});
		expect(hover?.contents?.value).toBe("fake hover");
		await client.shutdown();
	});
});
