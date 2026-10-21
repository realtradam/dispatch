// Deliberately outside the default test run. Run with Bun; no servers or data files.
// Baseline: git show 9312f27:packages/session-orchestrator/src/pure.ts > /tmp/be3-baseline.ts
// bun scripts/review-followup-be3-benchmark.ts /tmp/be3-baseline.ts 5000 1000000
// Optional positional filters after the module: retained, iterations, workload.
// After: bun scripts/review-followup-be3-benchmark.ts
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent, StepId } from "../packages/kernel/src/index.js";

const modulePath = resolve(process.argv[2] ?? "packages/session-orchestrator/src/pure.ts");
const api = await import(pathToFileURL(modulePath).href);
const base = { conversationId: "benchmark", turnId: "turn" };
const text = { ...base, type: "text-delta", delta: "x" } as const;
const result = (id: string): AgentEvent => ({
  ...base,
  type: "tool-result",
  stepId: "turn#0" as StepId,
  toolCallId: id,
  toolName: "benchmark",
  content: "ok",
  isError: false,
});
const output = (id: string): AgentEvent => ({
  ...base,
  type: "tool-output",
  toolCallId: id,
  stream: "stdout",
  data: "x".repeat(1024),
});
const status = { type: "status", conversationId: base.conversationId, status: "running" } as const;
const mixed: AgentEvent[] = Array.from({ length: 1024 }, (_, i) =>
  i % 4 === 0 ? status : i % 4 === 1 ? output("live") : i % 4 === 2 ? output("done") : text,
);
const rows = [];
for (const retained of process.argv[3] ? [Number(process.argv[3])] : [0, 5000, 10000]) {
  for (const events of process.argv[4]
    ? [Number(process.argv[4])]
    : [250_000, 500_000, 1_000_000]) {
    for (const workload of ["deltas", "invalidations"] as const) {
      if (process.argv[5] && workload !== process.argv[5]) continue;
      let buffer = api.createReplayBuffer?.() ?? [];
      const append = (event: AgentEvent) => {
        buffer = api.appendCompacted(buffer, event);
      };
      for (let i = 0; i < retained; i++) append(result(`seed-${i}`));
      append(result("done"));
      append(text);
      const start = performance.now();
      for (let i = 0; i < events; i++) {
        // Each cycle adds one result, invalidating only that cycle's output.
        if (workload === "invalidations" && i % 1024 === 1023) {
          append(result(`cycle-${i}`));
          append(output(`cycle-${i + 1024}`));
        } else append(workload === "deltas" ? text : (mixed[i % 1024] ?? text));
      }
      const ms = performance.now() - start;
      const snapshot: readonly AgentEvent[] = api.snapshotReplay?.(buffer) ?? buffer;
      assert(snapshot.length >= retained);
      if (workload === "deltas") {
        const tail = snapshot.at(-1);
        assert(tail?.type === "text-delta" && tail.delta.length === events + 1);
        assert.equal(snapshot.length, retained + 2);
      } else {
        assert.equal(snapshot.filter((event) => event.type === "status").length, 1);
        assert(
          !snapshot.some((event) => event.type === "tool-output" && event.toolCallId === "done"),
        );
      }
      const row = {
        retained,
        iterations: events,
        events: events + (workload === "invalidations" ? Math.floor(events / 1024) : 0),
        workload,
        ms: +ms.toFixed(2),
        finalRetained: snapshot.length,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
console.log(JSON.stringify({ modulePath, runtime: Bun.version, rows }));
