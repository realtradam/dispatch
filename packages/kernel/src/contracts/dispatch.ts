/**
 * Dispatch policy — controls how the kernel runs a step's tool calls.
 *
 * Two orthogonal axes, split so every combination is coherent:
 * - `maxConcurrent`: how many tools run at once (0=unlimited, 1=sequential, 2+=cap)
 * - `eager`: when execution starts (true=on arrival, false=after step finishes)
 *
 * The policy is a kernel input, never ambient — the session-orchestrator
 * resolves it and hands the final value to `runTurn`.
 */

/**
 * Controls how the kernel dispatches tool calls within a step.
 *
 * **`maxConcurrent`:**
 * - `0` — unlimited parallelism (deliberate opt-in; reopens the dedup footgun)
 * - `1` — sequential execution (a concurrency limit of 1 is exactly serial)
 * - `2+` — at most N tools run concurrently
 *
 * **`eager`:**
 * - `true` — launch each tool-call the instant it streams in from the provider
 *   (overlaps tool execution with the rest of generation)
 * - `false` — wait until the step's finish event, then dispatch the batch
 *
 * **Default:** `{ maxConcurrent: 1, eager: true }` — never two tools at once
 * (safe for any tool), yet the first tool starts during generation.
 */
export interface ToolDispatchPolicy {
	readonly maxConcurrent: number;
	readonly eager: boolean;
}
