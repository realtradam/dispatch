import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchDirConfig } from "../../src/config/watcher.js";

const TMP = join("/tmp/opencode", "dispatch-watchdir-test");

beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("watchDirConfig", () => {
	it("fires onChange (debounced) when <dir>/dispatch.toml changes", async () => {
		let calls = 0;
		const handle = watchDirConfig(TMP, () => {
			calls++;
		});
		// Let chokidar finish its initial scan before mutating the file.
		await wait(200);

		writeFileSync(join(TMP, "dispatch.toml"), `[permissions]\nread = "allow"\n`, "utf-8");
		// 300ms debounce + chokidar latency.
		await wait(700);

		handle.close();
		expect(calls).toBeGreaterThanOrEqual(1);
	});

	it("does not fire after close()", async () => {
		let calls = 0;
		const handle = watchDirConfig(TMP, () => {
			calls++;
		});
		await wait(200);
		handle.close();

		writeFileSync(join(TMP, "dispatch.toml"), `[permissions]\nedit = "deny"\n`, "utf-8");
		await wait(700);

		expect(calls).toBe(0);
	});
});
