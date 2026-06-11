import { describe, expect, it } from "vitest";
import {
	type FileWatcher,
	type FsAccess,
	LanguageServerClient,
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
});
