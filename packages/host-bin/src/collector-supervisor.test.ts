import { describe, expect, it } from "vitest";
import { type ChildHandle, createCollectorSupervisor } from "./collector-supervisor.js";

interface FakeChild {
	readonly handle: ChildHandle;
	resolveExit: (code: number) => void;
	readonly signals: string[];
}

function createFakeChild(code = 0): FakeChild {
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((r) => {
		resolveExit = r;
	});
	const signals: string[] = [];
	const handle: ChildHandle = {
		kill: (signal?: string) => {
			signals.push(signal ?? "SIGTERM");
			if (signal === "SIGKILL") resolveExit(code);
		},
		exited,
	};
	return { handle, resolveExit, signals };
}

function createFakeLogger() {
	const msgs: Array<{ level: string; msg: string }> = [];
	return {
		msgs,
		debug: () => {},
		info: (msg: string) => msgs.push({ level: "info", msg }),
		warn: (msg: string) => msgs.push({ level: "warn", msg }),
		error: () => {},
		child: () => createFakeLogger(),
		span: () => ({
			id: "s",
			log: createFakeLogger(),
			setAttributes: () => {},
			addLink: () => {},
			child: () => ({}) as never,
			end: () => {},
		}),
	};
}

describe("createCollectorSupervisor", () => {
	const DEFAULTS = {
		journalPath: "/tmp/journal.ndjson",
		dbPath: "/tmp/traces.db",
	};

	it("start() spawns with the correct command and args", () => {
		let capturedCmd: string[] = [];
		const children: FakeChild[] = [];
		const spawn = (cmd: string[]) => {
			capturedCmd = cmd;
			const child = createFakeChild();
			children.push(child);
			return child.handle;
		};

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
		});
		supervisor.start();

		expect(capturedCmd).toEqual([
			"bun",
			"packages/observability-collector/src/main.ts",
			"--journal",
			"/tmp/journal.ndjson",
			"--db",
			"/tmp/traces.db",
		]);
	});

	it("start() passes --interval when provided", () => {
		let capturedCmd: string[] = [];
		const spawn = (cmd: string[]) => {
			capturedCmd = cmd;
			return createFakeChild().handle;
		};

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			interval: 500,
			spawn,
			logger: createFakeLogger() as never,
		});
		supervisor.start();

		expect(capturedCmd).toContain("--interval");
		expect(capturedCmd).toContain("500");
	});

	it("unexpected child exit respawns the collector", async () => {
		const children: FakeChild[] = [];
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			const child = createFakeChild();
			children.push(child);
			return child.handle;
		};

		const time = 0;
		const now = () => time;
		const delayResolvers: Array<() => void> = [];
		const delay = (_ms: number) =>
			new Promise<void>((r) => {
				delayResolvers.push(r);
			});

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
			now,
			delay,
		});
		supervisor.start();

		expect(spawnCount).toBe(1);

		// Simulate unexpected exit
		children[0]?.resolveExit(1);
		await Promise.resolve();
		await Promise.resolve();

		// Trigger the backoff delay resolver
		expect(delayResolvers.length).toBe(1);
		delayResolvers[0]?.();
		await Promise.resolve();
		await Promise.resolve();

		expect(spawnCount).toBe(2);
	});

	it("restart guard caps respawns in a tight loop", async () => {
		const children: FakeChild[] = [];
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			const child = createFakeChild();
			children.push(child);
			return child.handle;
		};

		const time = 0;
		const now = () => time;
		const delayResolvers: Array<() => void> = [];
		const delay = (_ms: number) =>
			new Promise<void>((r) => {
				delayResolvers.push(r);
			});

		const logger = createFakeLogger();
		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: logger as never,
			now,
			delay,
		});
		supervisor.start();

		// Simulate rapid crashes (within the restart window)
		for (let i = 0; i < 5; i++) {
			children[i]?.resolveExit(1);
			await Promise.resolve();
			await Promise.resolve();
			if (delayResolvers.length > i) {
				delayResolvers[i]?.();
				await Promise.resolve();
				await Promise.resolve();
			}
		}

		// Should have spawned 6 times (1 initial + 5 restarts)
		expect(spawnCount).toBe(6);

		// 6th child also dies — should NOT respawn (cap reached)
		children[5]?.resolveExit(1);
		await Promise.resolve();
		await Promise.resolve();

		// spawnCount should still be 6
		expect(spawnCount).toBe(6);
		expect(logger.msgs.some((m) => m.msg === "Collector restart cap reached; giving up")).toBe(
			true,
		);
	});

	it("stop() sends SIGTERM and does not respawn", async () => {
		const child = createFakeChild();
		const spawn = () => child.handle;

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
		});
		supervisor.start();

		// Resolve exit after SIGTERM (simulating graceful shutdown)
		const stopPromise = supervisor.stop();
		child.resolveExit(0);
		await stopPromise;

		expect(child.signals).toContain("SIGTERM");
	});

	it("stop() sends SIGKILL when child does not exit in time", async () => {
		const child = createFakeChild();
		const spawn = () => child.handle;

		const time = 0;
		const now = () => time;
		const delayResolvers: Array<() => void> = [];
		const delay = (_ms: number) =>
			new Promise<void>((r) => {
				delayResolvers.push(r);
			});

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
			now,
			delay,
		});
		supervisor.start();

		const stopPromise = supervisor.stop();

		// Don't resolve exit — simulate hung child
		// Resolve the timeout delay instead
		expect(delayResolvers.length).toBe(1);
		delayResolvers[0]?.();
		await stopPromise;

		expect(child.signals).toContain("SIGTERM");
		expect(child.signals).toContain("SIGKILL");
	});

	it("stop() does not respawn after unexpected exit during stop", async () => {
		const children: FakeChild[] = [];
		let spawnCount = 0;
		const spawn = () => {
			spawnCount++;
			const child = createFakeChild();
			children.push(child);
			return child.handle;
		};

		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
		});
		supervisor.start();
		expect(spawnCount).toBe(1);

		// Child exits during stop — supervisor is already stopping
		const stopPromise = supervisor.stop();
		children[0]?.resolveExit(1);
		await stopPromise;

		// Should NOT have respawned
		expect(spawnCount).toBe(1);
	});

	it("spawn throwing does not throw to caller", () => {
		const spawn = () => {
			throw new Error("spawn failed");
		};

		const logger = createFakeLogger();
		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: logger as never,
		});

		expect(() => supervisor.start()).not.toThrow();
		expect(logger.msgs.some((m) => m.msg === "Failed to spawn collector")).toBe(true);
	});

	it("stop() is safe to call when no child was started", async () => {
		const spawn = () => createFakeChild().handle;
		const supervisor = createCollectorSupervisor({
			...DEFAULTS,
			spawn,
			logger: createFakeLogger() as never,
		});

		await expect(supervisor.stop()).resolves.toBeUndefined();
	});
});
