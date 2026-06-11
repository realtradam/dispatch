import { describe, expect, it } from "vitest";
import type { FileWatcher, FsAccess, SpawnedProcess, SpawnProcess } from "./client.js";
import { encode } from "./framing.js";
import { LspManager } from "./manager.js";

function makeAutoHandshakeSpawn(): SpawnProcess {
	return () => {
		let messageHandler: ((data: Uint8Array) => void) | null = null;

		const proc: SpawnedProcess = {
			stdin: {
				write: (bytes: Uint8Array) => {
					// Parse the message to handle initialize handshake
					const decoded = new TextDecoder().decode(bytes);
					const headerEnd = decoded.indexOf("\r\n\r\n");
					if (headerEnd === -1) return;
					const json = decoded.slice(headerEnd + 4);
					try {
						const msg = JSON.parse(json);
						if (msg.method === "initialize") {
							// Send back initialize response
							setTimeout(() => {
								const response = JSON.stringify({
									jsonrpc: "2.0",
									id: msg.id,
									result: { capabilities: {} },
								});
								messageHandler?.(encode(response));
							}, 5);
						}
						// Ignore other messages
					} catch {
						// ignore parse errors
					}
				},
			},
			stdout: {
				on: (_event: string, cb: (data: Uint8Array) => void) => {
					messageHandler = cb;
				},
			},
			pid: 12345,
			kill: () => {},
		};
		return proc;
	};
}

function noopFileWatcher(): FileWatcher {
	return () => ({ close: () => {} });
}

function fakeFs(files: Record<string, string> = {}): FsAccess {
	return {
		readText: async (path) => files[path] ?? "",
		exists: async (path) => path in files,
	};
}

describe("manager", () => {
	it("status(cwd) lazy-spawns matching servers and reports connected", async () => {
		const manager = new LspManager({
			spawn: makeAutoHandshakeSpawn(),
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/tsconfig.json": "{}",
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: {
						test: {
							command: ["test-lsp", "--stdio"],
							extensions: [".ts"],
							rootMarkers: ["tsconfig.json"],
						},
					},
				}),
			}),
		});

		const statuses = await manager.status("/project");
		expect(statuses).toHaveLength(1);
		expect(statuses[0]?.id).toBe("test");
		expect(statuses[0]?.state).toBe("connected");
		expect(statuses[0]?.root).toBe("/project");
	}, 10000);

	it("concurrent status for the same root spawns one process", async () => {
		let spawnCount = 0;
		const countingSpawn: SpawnProcess = () => {
			spawnCount++;
			return makeAutoHandshakeSpawn()([], { cwd: "/project" });
		};

		const manager = new LspManager({
			spawn: countingSpawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/tsconfig.json": "{}",
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: {
						test: {
							command: ["test-lsp"],
							extensions: [".ts"],
							rootMarkers: ["tsconfig.json"],
						},
					},
				}),
			}),
		});

		const [s1, s2] = await Promise.all([manager.status("/project"), manager.status("/project")]);

		expect(s1).toHaveLength(1);
		expect(s2).toHaveLength(1);
		expect(spawnCount).toBe(1);
	}, 10000);

	it("a failing spawn reports state:error and is not retried", async () => {
		let spawnCount = 0;
		const failingSpawn: SpawnProcess = () => {
			spawnCount++;
			throw new Error("spawn failed");
		};

		const manager = new LspManager({
			spawn: failingSpawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/tsconfig.json": "{}",
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: {
						test: {
							command: ["test-lsp"],
							extensions: [".ts"],
							rootMarkers: ["tsconfig.json"],
						},
					},
				}),
			}),
		});

		const s1 = await manager.status("/project");
		expect(s1[0]?.state).toBe("error");
		expect(spawnCount).toBe(1);

		// Second call should not retry
		const s2 = await manager.status("/project");
		expect(s2[0]?.state).toBe("error");
		expect(spawnCount).toBe(1);
	});

	it("shutdownAll kills all spawned processes (incl. sidecars)", async () => {
		let killed = false;
		const trackableSpawn: SpawnProcess = () => {
			const proc = makeAutoHandshakeSpawn()([], { cwd: "/project" });
			return {
				...proc,
				kill: () => {
					killed = true;
				},
			};
		};

		const manager = new LspManager({
			spawn: trackableSpawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/tsconfig.json": "{}",
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: {
						test: {
							command: ["test-lsp"],
							extensions: [".ts"],
							rootMarkers: ["tsconfig.json"],
						},
					},
				}),
			}),
		});

		await manager.status("/project");
		manager.shutdownAll();
		expect(killed).toBe(true);
	}, 10000);

	it("resolves config per cwd (distinct cwds, opencode.json fallback)", async () => {
		const manager = new LspManager({
			spawn: makeAutoHandshakeSpawn(),
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/proj-a/.dispatch/lsp.json": JSON.stringify({
					servers: { a: { command: ["a-lsp"], extensions: [".a"], rootMarkers: [] } },
				}),
				"/proj-b/opencode.json": JSON.stringify({
					lsp: { b: { command: ["b-lsp"], extensions: [".b"] } },
				}),
			}),
		});

		const a = await manager.status("/proj-a");
		const b = await manager.status("/proj-b");
		expect(a.map((s) => s.id)).toEqual(["a"]);
		expect(b.map((s) => s.id)).toEqual(["b"]);
	}, 10000);
});
