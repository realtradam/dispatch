import type { QueuedMessage } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import {
	buildQueueSpec,
	combine,
	drain,
	enqueue,
	getQueue,
	MESSAGE_QUEUE_RENDERER_ID,
	MESSAGE_QUEUE_SURFACE_ID,
	type MessageQueueState,
	type QueueDeps,
} from "./pure.js";

function makeDeps(): QueueDeps {
	let idCounter = 0;
	let now = 1_000;
	return {
		id: () => `id-${++idCounter}`,
		now: () => (now += 10),
	};
}

describe("enqueue", () => {
	it("enqueue appends + returns snapshot with the new message (id unique, queuedAt set)", () => {
		const state: MessageQueueState = new Map();
		const deps = makeDeps();

		const first = enqueue(state, "c1", "first", deps);
		expect(first).toHaveLength(1);
		const firstMsg = first[0];
		if (firstMsg === undefined) throw new Error("expected a message");
		expect(firstMsg.id).toBe("id-1");
		expect(firstMsg.text).toBe("first");
		expect(firstMsg.queuedAt).toBe(1_010);

		const second = enqueue(state, "c1", "second", deps);
		expect(second).toHaveLength(2);
		const secondMsg = second[1];
		if (secondMsg === undefined) throw new Error("expected a message");
		expect(secondMsg.id).toBe("id-2"); // unique per message
		expect(secondMsg.text).toBe("second");
		expect(secondMsg.queuedAt).toBe(1_020);

		// a separate conversation does not share state
		const other = enqueue(state, "c2", "other", deps);
		expect(other).toHaveLength(1);
		expect(getQueue(state, "c2")).toHaveLength(1);
	});
});

describe("getQueue", () => {
	it("getQueue returns current snapshot; empty array when none", () => {
		const state: MessageQueueState = new Map();
		const deps = makeDeps();

		expect(getQueue(state, "unknown")).toEqual([]);

		enqueue(state, "c1", "x", deps);
		enqueue(state, "c1", "y", deps);
		const snap = getQueue(state, "c1");
		expect(snap.map((m) => m.text)).toEqual(["x", "y"]);

		// returns a COPY — mutating it does not affect live state
		snap.push({ id: "evil", text: "mutate", queuedAt: 0 });
		expect(getQueue(state, "c1")).toHaveLength(2);
	});
});

describe("drain", () => {
	it("drain returns all + clears; second drain returns []", () => {
		const state: MessageQueueState = new Map();
		const deps = makeDeps();
		enqueue(state, "c1", "a", deps);
		enqueue(state, "c1", "b", deps);

		const drained = drain(state, "c1");
		expect(drained.map((m) => m.text)).toEqual(["a", "b"]);

		// cleared
		expect(getQueue(state, "c1")).toEqual([]);
		expect(drain(state, "c1")).toEqual([]);
	});

	it("drain on an empty queue returns [] and is a no-op", () => {
		const state: MessageQueueState = new Map();

		// never had a queue
		expect(drain(state, "c1")).toEqual([]);
		expect(getQueue(state, "c1")).toEqual([]);

		// and after a drain that emptied it, draining again is a no-op
		const deps = makeDeps();
		enqueue(state, "c1", "once", deps);
		drain(state, "c1");
		expect(drain(state, "c1")).toEqual([]);
		expect(getQueue(state, "c1")).toEqual([]);
	});
});

describe("combine", () => {
	it("combine joins texts with blank-line separator", () => {
		const msgs: QueuedMessage[] = [
			{ id: "1", text: "alpha", queuedAt: 1 },
			{ id: "2", text: "beta", queuedAt: 2 },
		];
		expect(combine(msgs)).toBe("alpha\n\nbeta");
		expect(combine([])).toBe("");
		expect(combine([{ id: "1", text: "solo", queuedAt: 1 }])).toBe("solo");
	});
});

describe("buildQueueSpec", () => {
	it("renders a custom field with the queue snapshot", () => {
		const msgs: QueuedMessage[] = [
			{ id: "1", text: "a", queuedAt: 1 },
			{ id: "2", text: "b", queuedAt: 2 },
		];
		const spec = buildQueueSpec(msgs);
		expect(spec.id).toBe(MESSAGE_QUEUE_SURFACE_ID);
		expect(spec.region).toBe("side");
		expect(spec.title).toBe("Message Queue");
		expect(spec.fields).toHaveLength(1);

		const field = spec.fields[0];
		if (field === undefined || field.kind !== "custom") {
			throw new Error("expected a custom field");
		}
		expect(field.rendererId).toBe(MESSAGE_QUEUE_RENDERER_ID);
		const payload = field.payload as { messages: readonly QueuedMessage[] };
		expect(payload.messages).toHaveLength(2);
		expect(payload.messages.map((m) => m.text)).toEqual(["a", "b"]);
	});

	it("renders an empty list for an empty queue", () => {
		const spec = buildQueueSpec([]);
		const field = spec.fields[0];
		if (field === undefined || field.kind !== "custom") {
			throw new Error("expected a custom field");
		}
		const payload = field.payload as { messages: readonly QueuedMessage[] };
		expect(payload.messages).toEqual([]);
	});
});
