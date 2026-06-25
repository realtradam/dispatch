import type { ProviderContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import {
	buildUserMessage,
	cumulativeSleepMs,
	defaultDispatchPolicy,
	delayFor,
	generateTurnId,
	RETRY_BUDGET_MS,
	RETRY_SCHEDULE_MS,
	RETRY_TAIL_MS,
	resolveReasoningEffort,
	selectFirstProvider,
} from "./pure.js";

describe("buildUserMessage", () => {
	it("creates a user message with a single text chunk", () => {
		const msg = buildUserMessage("hello world");
		expect(msg.role).toBe("user");
		expect(msg.chunks).toHaveLength(1);
		expect(msg.chunks[0]).toEqual({ type: "text", text: "hello world" });
	});

	it("preserves empty text", () => {
		const msg = buildUserMessage("");
		expect(msg.role).toBe("user");
		expect(msg.chunks[0]).toEqual({ type: "text", text: "" });
	});
});

describe("selectFirstProvider", () => {
	it("returns the first provider from a non-empty map", () => {
		const provider: ProviderContract = {
			id: "test-provider",
			stream: async function* () {},
		};
		const providers = new Map<string, ProviderContract>();
		providers.set("test-provider", provider);

		expect(selectFirstProvider(providers)).toBe(provider);
	});

	it("throws when the map is empty", () => {
		const providers = new Map<string, ProviderContract>();
		expect(() => selectFirstProvider(providers)).toThrow("No providers registered");
	});

	it("returns the first inserted provider when multiple exist", () => {
		const first: ProviderContract = { id: "first", stream: async function* () {} };
		const second: ProviderContract = { id: "second", stream: async function* () {} };
		const providers = new Map<string, ProviderContract>();
		providers.set("first", first);
		providers.set("second", second);

		expect(selectFirstProvider(providers).id).toBe("first");
	});
});

describe("defaultDispatchPolicy", () => {
	it("returns maxConcurrent: 1, eager: true", () => {
		expect(defaultDispatchPolicy()).toEqual({ maxConcurrent: 1, eager: true });
	});
});

describe("generateTurnId", () => {
	it("returns a string starting with 'turn-'", () => {
		const id = generateTurnId();
		expect(id).toMatch(/^turn-/);
	});

	it("returns unique ids", () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateTurnId()));
		expect(ids.size).toBe(100);
	});
});

describe("resolveReasoningEffort", () => {
	it("override wins over stored", () => {
		expect(resolveReasoningEffort("low", "high")).toBe("low");
		expect(resolveReasoningEffort("max", "medium")).toBe("max");
	});

	it("stored wins over default", () => {
		expect(resolveReasoningEffort(undefined, "medium")).toBe("medium");
		expect(resolveReasoningEffort(undefined, "xhigh")).toBe("xhigh");
	});

	it("default is 'high' when both are absent", () => {
		expect(resolveReasoningEffort(undefined, null)).toBe("high");
	});

	it("all 5 levels pass through as override", () => {
		expect(resolveReasoningEffort("low", null)).toBe("low");
		expect(resolveReasoningEffort("medium", null)).toBe("medium");
		expect(resolveReasoningEffort("high", null)).toBe("high");
		expect(resolveReasoningEffort("xhigh", null)).toBe("xhigh");
		expect(resolveReasoningEffort("max", null)).toBe("max");
	});

	it("all 5 levels pass through as stored", () => {
		expect(resolveReasoningEffort(undefined, "low")).toBe("low");
		expect(resolveReasoningEffort(undefined, "medium")).toBe("medium");
		expect(resolveReasoningEffort(undefined, "high")).toBe("high");
		expect(resolveReasoningEffort(undefined, "xhigh")).toBe("xhigh");
		expect(resolveReasoningEffort(undefined, "max")).toBe("max");
	});
});

describe("retry backoff schedule (delayFor)", () => {
	it("emits the stepped head: 5s, 10s, 30s, 60s, 5m, 10m, 15m, 30m", () => {
		expect(delayFor(0)).toBe(5_000);
		expect(delayFor(1)).toBe(10_000);
		expect(delayFor(2)).toBe(30_000);
		expect(delayFor(3)).toBe(60_000);
		expect(delayFor(4)).toBe(300_000);
		expect(delayFor(5)).toBe(600_000);
		expect(delayFor(6)).toBe(900_000);
		expect(delayFor(7)).toBe(1_800_000);
	});

	it("repeats 30m after the head", () => {
		expect(delayFor(8)).toBe(RETRY_TAIL_MS);
		expect(delayFor(9)).toBe(RETRY_TAIL_MS);
		expect(delayFor(20)).toBe(RETRY_TAIL_MS);
	});

	it("gives up (returns undefined) once cumulative sleep exceeds 8h", () => {
		// Head sums to 3,705,000 ms; +1,800,000 per extra step. 8h = 28,800,000.
		// attempt 20 cumulative = 3,705,000 + 13*1,800,000 = 27,105,000 (< 8h) → retry.
		expect(delayFor(20)).toBe(RETRY_TAIL_MS);
		// attempt 21 cumulative = 27,105,000 + 1,800,000 = 28,905,000 (> 8h) → stop.
		expect(delayFor(21)).toBeUndefined();
	});

	it("cumulativeSleepMs matches the sum of the schedule", () => {
		expect(cumulativeSleepMs(0)).toBe(5_000);
		expect(cumulativeSleepMs(1)).toBe(15_000);
		expect(cumulativeSleepMs(7)).toBe(RETRY_SCHEDULE_MS.reduce((a, b) => a + b, 0));
		// 8h budget is 28,800,000 ms.
		expect(RETRY_BUDGET_MS).toBe(8 * 60 * 60 * 1000);
		// The last retry (attempt 20) keeps cumulative under budget.
		expect(cumulativeSleepMs(20)).toBeLessThanOrEqual(RETRY_BUDGET_MS);
		// The next (attempt 21) exceeds it.
		expect(cumulativeSleepMs(21)).toBeGreaterThan(RETRY_BUDGET_MS);
	});

	it("the full schedule has 21 retries then stops", () => {
		const schedule: number[] = [];
		let attempt = 0;
		while (true) {
			const delay = delayFor(attempt);
			if (delay === undefined) break;
			schedule.push(delay);
			attempt++;
		}
		expect(schedule).toHaveLength(21);
		expect(schedule[0]).toBe(5_000);
		expect(schedule.at(-1)).toBe(RETRY_TAIL_MS);
		// 8 stepped head + 13 tail repeats.
		expect(schedule.slice(0, 8)).toEqual([...RETRY_SCHEDULE_MS]);
		expect(schedule.slice(8).every((d) => d === RETRY_TAIL_MS)).toBe(true);
	});
});
