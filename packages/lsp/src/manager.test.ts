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

	it("manager: broken server recovers after config is fixed (no shutdownAll)", async () => {
		const files: Record<string, string> = {
			"/project/tsconfig.json": "{}",
			"/project/.dispatch/lsp.json": JSON.stringify({
				servers: {
					test: {
						command: ["bad-lsp"],
						extensions: [".ts"],
						rootMarkers: ["tsconfig.json"],
					},
				},
			}),
		};

		const spawn: SpawnProcess = (command, opts) => {
			if (command[0] === "bad-lsp") throw new Error("spawn failed");
			return makeAutoHandshakeSpawn()(command, opts);
		};

		const manager = new LspManager({
			spawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs(files),
			now: () => 0,
		});

		// Bad config → spawn fails → broken.
		const s1 = await manager.status("/project");
		expect(s1[0]?.state).toBe("error");

		// Fix the config: switch the command to a working one. NO shutdownAll.
		files["/project/.dispatch/lsp.json"] = JSON.stringify({
			servers: {
				test: {
					command: ["good-lsp"],
					extensions: [".ts"],
					rootMarkers: ["tsconfig.json"],
				},
			},
		});

		// Next status() re-reads config, detects the change, and re-spawns.
		const s2 = await manager.status("/project");
		expect(s2[0]?.state).toBe("connected");
	}, 10000);

	it("manager: no retry storm — repeated status() with no config change does not re-spawn a broken server in a loop", async () => {
		let spawnCount = 0;
		const failingSpawn: SpawnProcess = () => {
			spawnCount++;
			throw new Error("spawn failed");
		};

		const manager = new LspManager({
			spawn: failingSpawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: { test: { command: ["test-lsp"], extensions: [".ts"] } },
				}),
			}),
			// Frozen clock: the bounded backoff never elapses, so a config-unchanged
			// broken server is never retried in a loop.
			now: () => 0,
		});

		await manager.status("/project");
		await manager.status("/project");
		await manager.status("/project");
		await manager.status("/project");

		expect(spawnCount).toBe(1);
	});

	it("manager: configSource reaches status()", async () => {
		const manager = new LspManager({
			spawn: makeAutoHandshakeSpawn(),
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/d/.dispatch/lsp.json": JSON.stringify({
					servers: { d: { command: ["d-lsp"], extensions: [".d"], rootMarkers: [] } },
				}),
				"/o/opencode.json": JSON.stringify({
					lsp: { o: { command: ["o-lsp"], extensions: [".o"] } },
				}),
				"/b/tsconfig.json": "{}",
			}),
			now: () => 0,
		});

		const d = await manager.status("/d");
		expect(d[0]?.configSource).toBe(".dispatch/lsp.json");

		const o = await manager.status("/o");
		expect(o[0]?.configSource).toBe("opencode.json");

		const b = await manager.status("/b");
		expect(b[0]?.configSource).toBe("built-in");
	}, 10000);

	it("config: shadow warning logged when .dispatch/lsp.json present and opencode.json also has lsp", async () => {
		const warns: Array<{
			msg: string;
			attrs?: Record<string, string | number | boolean | null>;
		}> = [];

		const manager = new LspManager({
			spawn: makeAutoHandshakeSpawn(),
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: { d: { command: ["d-lsp"], extensions: [".d"] } },
				}),
				"/project/opencode.json": JSON.stringify({
					lsp: { o: { command: ["o-lsp"], extensions: [".o"] } },
				}),
			}),
			logger: {
				info: () => {},
				warn: (msg, attrs) => warns.push({ msg, attrs }),
				error: () => {},
			},
			now: () => 0,
		});

		await manager.status("/project");

		const shadow = warns.find((w) => w.msg.includes("shadowing"));
		expect(shadow).toBeDefined();
		expect(shadow?.attrs?.cwd).toBe("/project");

		// A second status() over the SAME (still-shadowed) cwd does not re-warn.
		const before = warns.length;
		await manager.status("/project");
		expect(warns.length).toBe(before);
	}, 10000);

	it("status: error string includes config source on spawn failure", async () => {
		const failingSpawn: SpawnProcess = () => {
			throw new Error("spawn failed");
		};

		const manager = new LspManager({
			spawn: failingSpawn,
			fileWatcher: noopFileWatcher(),
			fs: fakeFs({
				"/project/.dispatch/lsp.json": JSON.stringify({
					servers: { test: { command: ["test-lsp"], extensions: [".ts"] } },
				}),
			}),
			now: () => 0,
		});

		const s = await manager.status("/project");
		expect(s[0]?.state).toBe("error");
		expect(s[0]?.configSource).toBe(".dispatch/lsp.json");
		expect(s[0]?.error).toContain("[from .dispatch/lsp.json]");
		expect(s[0]?.error).toContain("spawn failed");
	});
});
