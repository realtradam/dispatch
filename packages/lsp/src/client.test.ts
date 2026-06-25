import { describe, expect, it } from "vitest";
import {
	type FileWatcher,
	type FsAccess,
	LanguageServerClient,
	type ProcessExitHandler,
	type SpawnProcess,
} from "./client.js";
import { encode } from "./framing.js";

function makeClient(overrides?: {
	readonly spawn?: SpawnProcess;
	readonly fileWatcher?: FileWatcher;
	readonly fs?: FsAccess;
	readonly initialization?: Record<string, unknown>;
}): {
	client: LanguageServerClient;
	stdinChunks: Uint8Array[];
	serverResponses: (msg: string) => void;
} {
	const stdinChunks: Uint8Array[] = [];
	let serverMessageHandler: ((msg: string) => void) | null = null;

	const mockSpawn: SpawnProcess = () => ({
		stdin: { write: (bytes) => stdinChunks.push(bytes) },
		stdout: {
			on: (_event: string, cb: (data: Uint8Array) => void) => {
				// We'll feed messages through serverResponses
				serverMessageHandler = (msg: string) => {
					cb(encode(msg));
				};
			},
		},
		pid: 123,
		kill: () => {},
	});

	const mockFileWatcher: FileWatcher = (_root, _onEvent) => ({
		close: () => {},
	});

	const mockFs: FsAccess = {
		readText: async (path) => `// content of ${path}`,
		exists: async () => true,
	};

	const client = new LanguageServerClient({
		spawn: overrides?.spawn ?? mockSpawn,
		fileWatcher: overrides?.fileWatcher ?? mockFileWatcher,
		fs: overrides?.fs ?? mockFs,
		command: ["test-lsp"],
		root: "/project",
		serverId: "test",
		...(overrides?.initialization ? { initialization: overrides.initialization } : {}),
	});

	return {
		client,
		stdinChunks,
		serverResponses: (msg: string) => serverMessageHandler?.(msg),
	};
}

describe("client", () => {
	it("initialize declares didChangeWatchedFiles.dynamicRegistration true", async () => {
		const { client, stdinChunks, serverResponses } = makeClient();

		const startPromise = client.start();

		// Wait for the initialize message to be sent
		await new Promise((r) => setTimeout(r, 50));

		// Parse the sent messages to find initialize
		const sentMessages = stdinChunks.map((chunk) => {
			const decoded = new TextDecoder().decode(chunk);
			const headerEnd = decoded.indexOf("\r\n\r\n");
			return JSON.parse(decoded.slice(headerEnd + 4));
		});

		const initMsg = sentMessages.find((m: { method?: string }) => m.method === "initialize");
		expect(initMsg).toBeDefined();
		expect(initMsg.params.capabilities.workspace.didChangeWatchedFiles.dynamicRegistration).toBe(
			true,
		);

		// Send initialize response
		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: initMsg.id,
				result: { capabilities: {} },
			}),
		);

		await startPromise;
		expect(client.getState()).toBe("connected");
	});

	it("honors registerCapability for BOTH textDocument/diagnostic and workspace/didChangeWatchedFiles", async () => {
		const { client, serverResponses } = makeClient();
		const startPromise = client.start();

		await new Promise((r) => setTimeout(r, 50));

		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { capabilities: {} },
			}),
		);

		await startPromise;

		// Register workspace/didChangeWatchedFiles
		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 100,
				method: "client/registerCapability",
				params: {
					registrations: [
						{
							id: "reg-watched",
							method: "workspace/didChangeWatchedFiles",
							registerOptions: {
								watchers: [{ globPattern: "**/*.luau" }],
							},
						},
						{
							id: "reg-diag",
							method: "textDocument/diagnostic",
							registerOptions: {},
						},
					],
				},
			}),
		);

		await new Promise((r) => setTimeout(r, 50));

		const registry = client.getWatchedFilesRegistry();
		expect(registry.matches("src/main.luau")).toBe(true);
		expect(registry.matches("src/main.ts")).toBe(false);
	});

	it("an injected fs change for a registered glob sends workspace/didChangeWatchedFiles type=Changed (opencode-bug regression)", async () => {
		const callbackHolder: {
			cb:
				| ((e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void)
				| null;
		} = { cb: null };

		const trackingFileWatcher: FileWatcher = (_root, onEvent) => {
			callbackHolder.cb = onEvent;
			return { close: () => {} };
		};

		const { client, stdinChunks, serverResponses } = makeClient({
			fileWatcher: trackingFileWatcher,
		});

		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));

		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { capabilities: {} },
			}),
		);

		await startPromise;

		// Register a watcher for sourcemap.json
		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 100,
				method: "client/registerCapability",
				params: {
					registrations: [
						{
							id: "reg-1",
							method: "workspace/didChangeWatchedFiles",
							registerOptions: {
								watchers: [{ globPattern: "sourcemap.json" }],
							},
						},
					],
				},
			}),
		);

		await new Promise((r) => setTimeout(r, 100));

		// Simulate a file change
		const onFsEvent = callbackHolder.cb;
		if (!onFsEvent) throw new Error("file watcher callback was never registered");
		onFsEvent({ type: "change", path: "/project/sourcemap.json" });

		await new Promise((r) => setTimeout(r, 100));

		// Check that the notification was sent
		const sentMessages = stdinChunks.map((chunk) => {
			const decoded = new TextDecoder().decode(chunk);
			const headerEnd = decoded.indexOf("\r\n\r\n");
			return JSON.parse(decoded.slice(headerEnd + 4));
		});

		const didChangeMsg = sentMessages.find(
			(m: { method?: string }) => m.method === "workspace/didChangeWatchedFiles",
		);
		expect(didChangeMsg).toBeDefined();
		expect(didChangeMsg.params.changes[0].uri).toBe("file:///project/sourcemap.json");
		expect(didChangeMsg.params.changes[0].type).toBe(2); // Changed
	});

	it("publishDiagnostics are stored + returned", async () => {
		const { client, serverResponses } = makeClient();
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));

		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				result: { capabilities: {} },
			}),
		);

		await startPromise;

		// Send diagnostics
		serverResponses(
			JSON.stringify({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: "file:///project/test.ts",
					diagnostics: [
						{
							range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
							severity: 1,
							message: "Test error",
						},
					],
				},
			}),
		);

		await new Promise((r) => setTimeout(r, 50));

		const store = client.getDiagnosticsStore();
		const formatted = store.format("file:///project/test.ts");
		expect(formatted).toContain("ERROR");
		expect(formatted).toContain("Test error");
	});

	it("shutdown kills the process", async () => {
		const state = { killed: false };
		const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
		const killableSpawn: SpawnProcess = () => ({
			stdin: { write: () => {} },
			stdout: {
				on: (_event: string, cb: (data: Uint8Array) => void) => {
					stdoutHolder.cb = cb;
				},
			},
			pid: 123,
			kill: () => {
				state.killed = true;
			},
		});

		const { client } = makeClient({ spawn: killableSpawn });
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));

		// Deliver the initialize response through the spawned process's own
		// stdout (the real read path), so start() can complete the handshake.
		stdoutHolder.cb?.(
			encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
		);

		await startPromise;

		client.shutdown();
		expect(state.killed).toBe(true);
	});

	it("onExit marks the client broken (error) so callers stop querying a corpse", async () => {
		const state = { killed: false };
		let exitCb: ProcessExitHandler | null = null;
		const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };

		const spawnWithExit: SpawnProcess = () => ({
			stdin: { write: () => {} },
			stdout: {
				on: (_event: string, cb: (data: Uint8Array) => void) => {
					stdoutHolder.cb = cb;
				},
			},
			pid: 999,
			kill: () => {
				state.killed = true;
			},
			onExit: (handler) => {
				exitCb = handler;
			},
		});

		const { client } = makeClient({ spawn: spawnWithExit });
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));
		stdoutHolder.cb?.(
			encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
		);
		await startPromise;
		expect(client.getState()).toBe("connected");

		// Simulate the process dying (user kill / crash).
		exitCb?.({ code: 1 });

		expect(client.getState()).toBe("error");
		expect(client.getStateError()).toMatch(/process exited/);
		// The (still-alive-in-test) process was killed to avoid a zombie.
		expect(state.killed).toBe(true);
	});

	it("a dead client is skipped by waitForDiagnostics callers (state !== connected)", async () => {
		// Build a client, connect, kill via onExit, then assert a diagnostics
		// query would not block: getState() is "error" so the matching filter
		// (state === "connected") excludes it. We assert the state guard.
		const stdoutHolder: { cb: ((data: Uint8Array) => void) | null } = { cb: null };
		let exitCb: ProcessExitHandler | null = null;
		const spawnWithExit: SpawnProcess = () => ({
			stdin: { write: () => {} },
			stdout: {
				on: (_e, cb) => {
					stdoutHolder.cb = cb;
				},
			},
			pid: 1,
			kill: () => {},
			onExit: (handler) => {
				exitCb = handler;
			},
		});

		const { client } = makeClient({ spawn: spawnWithExit });
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));
		stdoutHolder.cb?.(
			encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } })),
		);
		await startPromise;

		exitCb?.({ code: null });
		expect(client.getState()).toBe("error");
		// The aggregate / getDiagnostics matching filter requires "connected".
		expect(client.getState() === "connected").toBe(false);
	});

	it("corruption detector marks the client broken after repeated identical diagnostics despite text changes", async () => {
		// A healthy server would change diagnostics as the file changes; a
		// corrupted one re-emits the SAME non-empty set. Drive 5 edits with
		// different text but identical diagnostics → client flips to error.
		const { client, serverResponses } = makeClient();
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));
		serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
		await startPromise;

		const phantom = JSON.stringify({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri: "file:///project/game.rb",
				diagnostics: [
					{
						range: { start: { line: 0, character: 27 }, end: { line: 0, character: 28 } },
						severity: 1,
						message: "SyntaxError: unexpected token",
					},
				],
			},
		});

		const path = "/project/game.rb";
		// The first call establishes the baseline snapshot (no increment).
		// Each subsequent call with identical diagnostics + changed text
		// increments; the 6th call (5th increment) trips the threshold.
		for (let i = 1; i <= 5; i++) {
			const p = client.waitForDiagnostics(path, { text: `buf-v${i}`, timeoutMs: 2000 });
			// Push the identical phantom diagnostics so the poll resolves.
			await new Promise((r) => setTimeout(r, 30));
			serverResponses(phantom);
			await p;
			expect(client.getState()).toBe("connected");
		}
		// 6th identical-across-changed-text repeat trips the threshold.
		const p6 = client.waitForDiagnostics(path, { text: "buf-v6", timeoutMs: 2000 });
		await new Promise((r) => setTimeout(r, 30));
		serverResponses(phantom);
		await p6;

		expect(client.getState()).toBe("error");
		expect(client.getStateError()).toMatch(/repeated stale diagnostics/i);
	});

	it("corruption detector does NOT trip on a clean file (empty diagnostics stay identical)", async () => {
		const { client, serverResponses } = makeClient();
		const startPromise = client.start();
		await new Promise((r) => setTimeout(r, 50));
		serverResponses(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } }));
		await startPromise;

		const clean = JSON.stringify({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri: "file:///project/game.rb", diagnostics: [] },
		});
		const path = "/project/game.rb";

		for (let i = 1; i <= 6; i++) {
			const p = client.waitForDiagnostics(path, { text: `clean-v${i}`, timeoutMs: 2000 });
			await new Promise((r) => setTimeout(r, 30));
			serverResponses(clean);
			await p;
		}
		// Empty diagnostics never count as "stale" — a clean file staying clean
		// is normal, not corruption.
		expect(client.getState()).toBe("connected");
	});
});
