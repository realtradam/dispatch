import type { SurfaceSpec } from "@dispatch/ui-contract";
import type { QueuedMessage, QueuePayload } from "@dispatch/wire";
import { describe, expect, it } from "vitest";
import { buildQueueSpec, combine } from "./pure.js";
import { createMessageQueueService, type MessageQueueDeps } from "./service.js";

interface Recorder extends MessageQueueDeps {
  readonly calls: { value: number };
}

function makeDeps(): Recorder {
  let idCounter = 0;
  let now = 1_000;
  const calls = { value: 0 };
  return {
    id: () => `q-${++idCounter}`,
    now: () => (now += 10),
    notify: () => {
      calls.value += 1;
    },
    calls,
  };
}

function queueMessages(spec: SurfaceSpec): readonly QueuedMessage[] {
  const field = spec.fields[0];
  if (field === undefined || field.kind !== "custom") {
    throw new Error("expected a custom field");
  }
  return (field.payload as QueuePayload).messages;
}

describe("message-queue service", () => {
  it("enqueue pushes a surface update (snapshot grew)", () => {
    const deps = makeDeps();
    const svc = createMessageQueueService(deps);
    expect(deps.calls.value).toBe(0);

    const snapshot = svc.enqueue("c1", "hello");
    expect(deps.calls.value).toBe(1); // surface update pushed
    expect(snapshot).toHaveLength(1);
    const first = snapshot[0];
    if (first === undefined) throw new Error("expected a message");
    expect(first.text).toBe("hello");
    expect(typeof first.id).toBe("string");
    expect(first.queuedAt).toBe(1_010);

    // the surface spec reflects the grown snapshot
    expect(queueMessages(buildQueueSpec(svc.getQueue("c1")))).toHaveLength(1);
  });

  it("drain pushes a surface update (empty)", () => {
    const deps = makeDeps();
    const svc = createMessageQueueService(deps);
    svc.enqueue("c1", "a");
    svc.enqueue("c1", "b");
    expect(deps.calls.value).toBe(2); // two enqueues notified

    const drained = svc.drain("c1");
    expect(deps.calls.value).toBe(3); // drain pushed a surface update
    expect(drained).toHaveLength(2);
    expect(drained.map((m) => m.text)).toEqual(["a", "b"]);

    // cleared + surface now shows empty
    expect(svc.getQueue("c1")).toEqual([]);
    expect(queueMessages(buildQueueSpec(svc.getQueue("c1")))).toEqual([]);
  });

  it("drain on empty does NOT push a surface update (already empty)", () => {
    const deps = makeDeps();
    const svc = createMessageQueueService(deps);

    expect(svc.drain("c1")).toEqual([]);
    expect(deps.calls.value).toBe(0); // no notify — no change

    // after a real drain empties it, a further drain is a no-op (no notify)
    svc.enqueue("c1", "x");
    expect(deps.calls.value).toBe(1);
    svc.drain("c1");
    expect(deps.calls.value).toBe(2);
    svc.drain("c1");
    expect(deps.calls.value).toBe(2); // unchanged — queue was already empty
  });

  it("getQueue returns current snapshot; empty for unknown conversation", () => {
    const deps = makeDeps();
    const svc = createMessageQueueService(deps);
    expect(svc.getQueue("nope")).toEqual([]);
    svc.enqueue("c1", "hi");
    expect(svc.getQueue("c1")).toHaveLength(1);
  });

  it("drain returns the raw QueuedMessage[] the orchestrator combines", () => {
    const deps = makeDeps();
    const svc = createMessageQueueService(deps);
    svc.enqueue("c1", "alpha");
    svc.enqueue("c1", "beta");
    const drained = svc.drain("c1");
    expect(combine(drained)).toBe("alpha\n\nbeta");
  });
});
