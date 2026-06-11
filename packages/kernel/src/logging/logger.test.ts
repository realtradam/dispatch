import { describe, expect, it } from "vitest";
import type { LogDeps, LogRecord, LogSink } from "../contracts/logging.js";
import { createLogger } from "./logger.js";

function harness() {
	let idCounter = 0;
	const deps: LogDeps = {
		now: () => 1000 + idCounter * 10,
		newId: () => `span-${++idCounter}`,
	};
	const records: LogRecord[] = [];
	const sink: LogSink = { emit: (r) => records.push(r) };
	return { logger: createLogger({ extensionId: "test" }, sink, deps), records };
}

describe("createLogger child-bound attributes", () => {
	it("merges child-bound attrs into BOTH span-open and span-close records", () => {
		const { logger, records } = harness();
		// Bind `warm: true` via child() — mirrors the cache-warming capture path.
		const warmLogger = logger.child({ conversationId: "c1", attrs: { warm: true } });

		const span = warmLogger.span("provider.request", { model: "x" });
		span.end({ attrs: { "usage.cacheReadTokens": 0 } });

		const open = records.find((r) => r.kind === "span-open");
		const close = records.find((r) => r.kind === "span-close");

		// Open carries the bound attr (pre-existing behavior).
		expect(open?.attributes?.warm).toBe(true);
		// Close MUST carry it too, so a `warm = true` query finds the closed span
		// (with its usage/status) — not just the open record.
		expect(close?.attributes?.warm).toBe(true);
		// Span-specific attrs from span()/end() are still present on close.
		expect(close?.attributes?.model).toBe("x");
		expect(close?.attributes?.["usage.cacheReadTokens"]).toBe(0);
	});

	it("omits attributes entirely when neither bound nor span attrs exist", () => {
		const { logger, records } = harness();
		const span = logger.span("bare");
		span.end();
		const close = records.find((r) => r.kind === "span-close");
		expect(close?.attributes).toBeUndefined();
	});
});
