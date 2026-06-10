import type { StorageNamespace } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { dayKeyOf } from "./period.js";
import { createThroughputStore, ThroughputQueryError } from "./store.js";

function memStorage(): StorageNamespace {
	const map = new Map<string, string>();
	return {
		get: async (k) => map.get(k) ?? null,
		set: async (k, v) => {
			map.set(k, v);
		},
		delete: async (k) => {
			map.delete(k);
		},
		has: async (k) => map.has(k),
		keys: async (prefix) =>
			[...map.keys()].filter((k) => (prefix === undefined ? true : k.startsWith(prefix))),
	};
}

let id = 0;
const store = () => createThroughputStore({ storage: memStorage(), newId: () => `id${id++}` });

describe("ThroughputStore", () => {
	it("records a sample and aggregates it for that day", async () => {
		const s = store();
		const ts = new Date(2026, 5, 10, 12, 0, 0).getTime();
		await s.record({ model: "claude/haiku", ts, outputTokens: 300, genMs: 1500 });

		const report = await s.aggregate({ period: "day", date: dayKeyOf(ts) });
		expect(report.models).toHaveLength(1);
		expect(report.models[0]).toMatchObject({
			model: "claude/haiku",
			totalOutputTokens: 300,
			totalGenMs: 1500,
			turns: 1,
			tokensPerSecond: 200, // 300 / 1.5s
		});
	});

	it("does not lose concurrent samples (single-set writes)", async () => {
		const s = store();
		const ts = new Date(2026, 5, 10, 9, 0, 0).getTime();
		await Promise.all([
			s.record({ model: "m", ts, outputTokens: 100, genMs: 1000 }),
			s.record({ model: "m", ts, outputTokens: 100, genMs: 1000 }),
			s.record({ model: "m", ts, outputTokens: 100, genMs: 1000 }),
		]);
		const report = await s.aggregate({ period: "day", date: dayKeyOf(ts) });
		expect(report.models[0]?.turns).toBe(3);
		expect(report.models[0]?.totalOutputTokens).toBe(300);
	});

	it("aggregates multiple days within a week", async () => {
		const s = store();
		const mon = new Date(2026, 5, 8, 10, 0, 0).getTime(); // Mon 2026-06-08
		const wed = new Date(2026, 5, 10, 10, 0, 0).getTime();
		await s.record({ model: "m", ts: mon, outputTokens: 100, genMs: 1000 });
		await s.record({ model: "m", ts: wed, outputTokens: 200, genMs: 1000 });

		const report = await s.aggregate({ period: "week", date: dayKeyOf(wed) });
		expect(report.models[0]?.turns).toBe(2);
		expect(report.models[0]?.totalOutputTokens).toBe(300);
	});

	it("throws ThroughputQueryError on a malformed date", async () => {
		await expect(store().aggregate({ period: "day", date: "garbage" })).rejects.toBeInstanceOf(
			ThroughputQueryError,
		);
	});
});
