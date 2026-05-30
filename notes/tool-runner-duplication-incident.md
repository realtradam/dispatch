# Incident Report: Duplicated Tool Output in Dispatch Harness

**Date:** 2025-05-30
**Component:** Dispatch AI harness — tool runner / tool-result delivery
**Severity:** Medium (no data corruption, but severe context pollution and wasted tokens/latency)
**Status:** Observed, not root-caused

---

## Summary

During the exploration phase of a code task (disabling the todo/tasks skill),
a single assistant turn that batched a large number of independent,
read-only tool calls came back with **massively duplicated tool results**.
The same `read_file`, `list_files`, and `run_shell` invocations were echoed
back dozens of times each, producing a multi-thousand-line "wall" of
near-identical output for what should have been a few dozen distinct results.

The actual file edits performed later in the task landed correctly — this was
an **output/delivery problem**, not a state-corruption problem. But the
duplication wasted a large amount of context window, made the transcript very
hard to read, and could plausibly cause an agent to lose track of its plan or
hit context limits on a larger task.

---

## What I observed

I emitted **one** assistant message containing a large parallel batch of
independent tool calls (the correct pattern for independent reads). The batch
included things like:

- `read_file packages/api/src/agent-manager.ts` (several distinct line ranges)
- `read_file package.json`
- `list_files packages/api/src`
- various `run_shell` commands (`grep`, `sed`, `awk`, plus debug probes like
  `echo hello`, `echo hi`, `pwd`)

Instead of one result per call, the results stream contained the **same
results repeated many times over**. Concrete examples from the transcript:

| Tool call | Approx. times the identical result appeared |
|---|---|
| `read_file package.json` (lines 1-5) | ~150+ |
| `read_file agent-manager.ts` (lines 75-126 / 76-127 / 78-117) | ~40+ |
| `list_files packages/api/src` | ~20 |
| `run_shell sed -n '75,127p' ...` | ~13 |
| `run_shell awk 'NR>=75...'` | ~12 |
| `run_shell echo hello` | ~16 |
| `run_shell pwd` | ~20 |

The duplicated blocks were **byte-for-byte identical** (same line ranges, same
content, same exit codes). They were not re-reads of changed files — the
content was stable across every repeat.

### Notable characteristics

1. **Read-only and idempotent calls were the ones duplicated.** The heavy
   duplication clustered on `read_file` / `list_files` / trivial `run_shell`
   probes. This is consistent with the harness retrying or re-emitting results
   for calls it considered safe/idempotent.
2. **The duplication count was wildly uneven.** `package.json` (a tiny file)
   was echoed ~150 times while a single `read_file_slice` appeared once. The
   multiplier was not constant across calls.
3. **A genuinely valuable signal was nearly buried.** One real result hid in
   the noise: `read_file agent-manager.ts` lines 75-126 truncated mid-line and
   instructed me to use `read_file_slice` — easy to miss in a wall of
   duplicates.
4. **No effect on writes.** The later `write_file`/`run_shell` mutation steps
   each returned exactly once and produced correct results, and the final
   `git diff --stat` matched expectations (6 insertions, 168 deletions across
   8 files). So the glitch appears confined to result *delivery/echo*, not
   tool *execution*.

---

## Impact

- **Context pollution:** Thousands of redundant lines consumed the context
  window. On a larger codebase or a longer task this could trigger truncation
  or force premature summarization.
- **Readability:** The human-facing transcript became almost unreadable for
  the exploration phase; it's hard to audit what the agent actually looked at.
- **Cost/latency:** Re-emitting and re-processing identical results wastes
  tokens and time.
- **Reasoning risk:** Heavy duplication can bias or confuse a model
  (repetition can be read as emphasis), and the near-miss on the truncation
  hint shows real signals can get lost.

---

## What I could NOT determine

- Whether the duplication originated in:
  - the **tool runner** (executing/emitting each call multiple times),
  - the **result serializer/transport** (one execution, many echoes), or
  - a **retry/timeout loop** (calls re-issued after a perceived stall).
- Whether the trigger was the **large fan-out batch size** specifically, or
  something incidental.
- Whether other agents on the same harness see it (single-session
  observation only).

The byte-identical nature of the repeats (including stable `pwd` and `echo`
output) leans toward an **echo/transport duplication** rather than genuine
re-execution, but that is inference, not proof.

---

## Reproduction hypothesis

Not reliably reproduced. The strongest correlated factor was **a single turn
with a large number (dozens) of independent tool calls batched together**,
heavily weighted toward `read_file` on small files. Suggested repro attempt:

1. In one assistant turn, batch ~30+ independent `read_file` calls, several
   targeting the same small file at different line ranges.
2. Mix in a few cheap `run_shell` probes (`echo`, `pwd`).
3. Observe whether results are echoed >1× and whether the multiplier varies
   per call.

---

## Suggested follow-ups for the harness maintainers

1. **Deduplicate / cap result emission per tool_call_id.** Each tool call has
   a unique id; the result stream should emit exactly one result per id.
   Assert this invariant and drop/merge duplicates.
2. **Log the executor path.** Add a counter for "executions per tool_call_id"
   vs "results delivered per tool_call_id" to distinguish re-execution from
   re-echo.
3. **Investigate the batch/fan-out path.** Check whether large parallel tool
   batches trigger a retry or a fan-in bug that replays buffered results.
4. **Surface truncation hints robustly.** When a `read_file` result is
   truncated, ensure that notice survives any dedup/compaction so the agent
   doesn't miss it.
5. **Consider a per-turn result-size guardrail** that warns when duplicate
   identical results are detected.

---

## Notes

- This document records a single observed session. Numbers above are
  approximate counts read from the transcript, not exact instrumentation.
- The underlying code task completed successfully and was verified
  independently (targeted test suites passed, typechecks clean); this report
  concerns only the harness behavior, not the task outcome.
