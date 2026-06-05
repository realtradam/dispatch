# Observability & Debugging — Design Scratch

> **Status:** IDEATION / scratch. NOT the plan, NOT decided-to-build. Captures a
> live design discussion so decisions don't live only in chat (per ORCHESTRATOR
> "write up before pivoting"). Promote settled parts into
> `notes/restructure-plan.md` + `GLOSSARY.md` when we commit to building.
> **Scope:** backend only. **Driver:** old Dispatch had bugs that were near-
> impossible to diagnose because an agent had *no real data to read*. This fixes
> that at the root.
>
> **Read order (fresh agent picking this up):** `ORCHESTRATOR.md` →
> `notes/restructure-plan.md` (the §-refs below point into it) → `GLOSSARY.md` →
> this file. **Mode = IDEATION with the user** (discuss/design, do NOT build yet);
> the user owns the boundary + vocabulary calls (§5.2 / §5.6).
> **Where we left off:** **Logger ABI = A, LOCKED** (evolve in place, §8). **Now
> PLANNING Phase A** (logging substrate, §10): A1 kernel Logger/Span ABI → A2
> `journal-sink` package (in-process, host-bin-injected) → A3 runtime span
> instrumentation. Phase A captures the **"BEFORE"** (verbatim pre-mutation prompt on
> the step span, via a new `LogRecord.body` blob); the **"AFTER"** (provider.request
> verbatim, D5) is the **next step** → completes full round-trip rebuild + the
> before↔after diff. **2 processes total, no more:** process 1 = main app *incl. the
> in-process journal sink* + the journal file; process 2 = the **collector** (Phase B).
> A package ≠ a process — the sink runs in-process (cheap non-blocking append); the
> file-seam + out-of-process collector is what delivers the crash-safety.
> **Redaction = each ext self-redacts IN ISOLATION** (no shared helper; P1/P7).
> **D10** = logs are one-way. **§9** extension-logging rule → `.dispatch/rules/`
> (placement decided; authored with the substrate). Crash-safety: journal file IS the
> durable queue (§6/D3). **Mode: PLANNING Phase A (not building yet).** Settled:
> D1–D10 (§2); open per-phase: §6.

---

## 0. Goal in one paragraph

First-class, **agent-first** debugging. When something goes wrong with a chat or
feature, you grab an **ID** and hand it to a **debugging agent**; it pinpoints the
*source* of the problem from a **complete, queryable trace** of what actually
happened, then hands its findings up to the orchestrator, which dispatches fixers.
The debugging agent is trained ONLY to find root cause — it does not fix.

---

## 1. Principles specific to this subsystem

- **Agent-first.** The primary trace *consumer is an LLM*, not a human dashboard.
  This single fact killed the OpenTelemetry path (see D1): its entire payoff is
  human visualization, which is useless to the agent. Every field we capture is
  justified by *"what query must the debugging agent run?"*
- **"Complete" = completely *captured & queryable*, never completely *loaded into
  context*.** Noise reduction is done by deterministic **query/filter tools**
  (plain code), so the agent always reads a small, targeted slice (a timeline
  skeleton → drill into one span; a diff; a validator verdict). **Store fat, serve
  thin.** This is the harness's progressive-disclosure idea (P5) applied to
  runtime data, and it's what protects context + usage.
- **Subordinate & fail-safe.** Observability must NEVER break or slow a turn. A
  tracing error, full disk, or downed collector → drop/sample + warn, never stall.
  (The §3.7 fault-containment principle: the turn is sovereign.)
- **The debugger must survive the crash it's debugging** (see D3). Robustness of
  the collector is paramount — it's the explicit reason it gets an exception to
  the in-process architecture.

---

## 2. Decisions settled so far (with the named problem each solves — P4)

### D1 — Agent-first; OpenTelemetry dropped
No OTLP exporter, no Jaeger/Tempo/Grafana, no OTel SDK, no "stay compatible"
constraint. Its value is human dashboards + cross-service fleet tracing — we are
one process whose reader is an agent. **Kept** (not as "OTel" but because it's the
right abstraction for *"what caused X"*): the **causal-trace model** — spans with
**parent + links + attributes**. Designed for agent queryability, not rendering.
- *Rejected by a named tradeoff, not NIH:* the OTel SDK's ambient "current span"
  (`AsyncLocalStorage`) is exactly the hidden global P3 bans; we pass correlation
  explicitly. Dropping it removes that tax + a heavy dep tree.

### D2 — Boundary: kernel owns types+mechanism; one `observability` extension owns the rest
(User's granularity call, §5.2.)
- **Kernel (ABI):** the structured-log + span **types**, the scoped logger/trace
  **handle** shape, and the **`onAny`** firehose (reserved in §5.4 / ORCHESTRATOR
  §6, **not yet built**). Kernel still touches no I/O and names no feature.
- **`observability` extension:** capture (onAny tap + AgentEvent tap + the scoped
  handles), the store, the query/filter tools, redaction, and the debugging-agent
  harness (P7).

### D3 — The collector runs OUT OF PROCESS (the sanctioned exception)
Single-process app (§3.7): a buggy extension can crash/`exit`/OOM everything. An
in-process collector buffering in memory loses its evidence **at the exact moment
you need it** (the crash). So the **sink** behind the logging handle is a separate
OS process. Three agent-first wins only this enables:
1. **Query a chat that killed the main process** — the collector stays alive, so
   the agent can debug a dead app. (Decisive.)
2. **Attribute the crash** — collector sees pipe EOF / heartbeat loss → stamps a
   synthetic terminal span "process exited unexpectedly after span X." In-process
   that final fact dies with the recorder.
3. **Isolate the query workload** from the live turn.

**Robust shape (write-ahead logging for telemetry):**
```
main process ──(cheap, non-blocking, append-only line)──▶ journal file (durable buffer)
                                                              │ tails
                                              standalone collector process
                                                normalize → SQLite trace store → query API ◀── debugging agent
```
- Hot path only **appends a line to an OS-buffered fd** — no SQLite, no blocking;
  buffer full → drop/sample (fail-safe).
- The **journal file is the queue**: if both processes die, flushed bytes are on
  disk; collector resumes tailing on restart. Worst case loses the last partial
  line (the §3.4 "last in-flight" bound).
- Collector is **deliberately dead-simple** (read→normalize→store→serve): the
  less it does, the less it can crash.
- **Exception scoped tightly:** extensions still emit through a normal
  `host.logger`/trace handle — *the contract is unchanged*; only the sink's
  *implementation* is out-of-process. This is the first real use of §3.7's
  pre-designed "move an extension to a worker without a rewrite" (serializable
  payloads). It fits the architecture rather than fighting it.
- *Cost (honest):* a second process host-bin spawns first / drains last + a tiny
  line protocol. Justified by the "must be robust" priority.

### D4 — Correlation model (reuses existing keys — P8, no invented id)
- **turn = one trace** (`turnId` ≈ trace id).
- **conversationId = an indexed attribute** grouping a thread's turn-traces.
- **span = one occurrence** of work (its own span id), with `parentSpanId`.
- **extension.id = an auto-stamped attribute** — the host hands each extension a
  handle pre-tagged with its `manifest.id`; nobody can spoof or invent an id
  scheme. (This is the clean version of "each extension broadcasts its id.")
- **Cross-feature causality = span links**, recorded **at the handoff moment**
  (enqueue→dequeue, summon→subagent-turn) — *causal edges, not co-occurrence.*
- Every span carries the correlation keys of what it acts on (e.g. a cross-chat
  op records both `source.conversationId` and `target.conversationId`).

### D5 — Verbatim provider I/O capture (the highest-value capture)
The cure for "the agent had no real data." Rule:
- **Capture the request verbatim at the fetch edge — AFTER all transforms** (OAuth
  body rewrite, tool-name prefixing, normalization). Corrupted-history bugs are
  often *introduced by* a transform; capture before the bytes hit the wire = ground
  truth (URL, model, params, full messages array, tool schemas, cache markers).
- **Capture the raw response/error too** (status + error JSON — it usually *names*
  the defect, e.g. `MissingToolResultsError`).
- **Redact only secrets** (auth headers, vault-injected fields) — never the body.
  **Technique = partial masking, NOT removal** (user-decided): reveal a few first +
  last real chars with `…redacted…` between (e.g. `sk-…redacted…f9a`), **graduated by
  length** so short secrets reveal less (tiers in §6). The field stays present and
  **diffable** (tells you if a secret changed/rotated — serves the §3.1 cache-bust
  diff) without storing the live value.
  **Mechanism (user-decided): each extension self-redacts IN ISOLATION — no shared
  helper.** Logs are self-generated, so they are self-redacted: the extension that
  owns the data — it alone knows what is secret and *how* to censor it — masks the
  value in **its own code, at the log call-site**, before the record is built. There
  is **no shared `redact()` utility and nothing in the kernel** for this: a shared
  helper would couple every secret-handling extension to one algorithm (violates
  **P1** feature-as-a-library + kernel-minimalism) and contradicts "the code decides
  *how* to censor." Consistency comes from the **harness, not shared code** (**P7**):
  the §9 rule makes self-redaction mandatory and documents the default tiers; **each
  extension reimplements them locally**. Duplicating a tiny mask across the few
  secret-handling exts (providers, auth) is **intentional — isolation over DRY**.
  Result: raw secrets never leave the producing extension's code — they reach neither
  the sink nor the journal.
  *(Supersedes the earlier "shared helper / mask at mint" sketches. Refines D2: the
  observability ext owns redaction POLICY/config + store/query; the redaction ACT is
  each source extension's own, self-contained.)*
  **Caveat (honest):** no scheme can mask a secret nobody marked — so the real
  enforcement is the §9 harness rule; an optional cheap sink-side pattern-scan
  (`sk-…`) may backstop obvious leaks but is not relied upon.
- **Retain successful requests in-window** (not error-only) so "diff failing vs a
  known-good chat" works. Cost: bodies are large → retention/rotation + compression.
- **Volume control (cache warming):** stamp the cheap `prefix.fingerprint` +
  cache-token counts on *every* request, but persist the **full body only when the
  fingerprint changed** (or on error) — keeps the bust findable without storing
  every warming send verbatim.
- **Store fat, serve thin:** the blob lives in the store; the agent gets a **diff**
  or a **validator verdict**, never the raw 200KB.
- *Future affordance (free from the data):* replay a stored request to reproduce.

### D6 — Per-extension observability: free by default, rich by opt-in (P4)
- **Default = free:** the auto-scoped structured handle (D4) makes *every*
  extension observable for nothing — no per-extension logging contract to write.
- **Opt-in = a typed debug surface** only where an extension has domain-specific
  diagnostics worth standardizing (queue's enqueue/dequeue/deliver lifecycle).
  Lives in that extension's own **P7 harness**, loaded by the debugging agent only
  when investigating that extension. Mandating a hand-written contract per
  extension would be the boilerplate P4 warns against.
- **Worked boundary (who computes an attribute):** the `prefix.fingerprint` (§3.1)
  can't be computed by the generic collector — only the cache-warming/provider
  extension knows where the cacheable prefix ends. So that extension stamps the
  attribute; the collector just stores it. The template for every "who computes
  this attribute?" question.

### D7 — Performance posture
Negligible. An agent turn is **LLM-network-bound (seconds)**; span/attribute work
is microseconds — in the noise. The only real cost is **write I/O + volume**,
solved by: non-blocking append (D3) + out-of-process normalize + **don't trace
token deltas** (high-frequency *and* redundant — the chunk log already has final
text) + levels/sampling + fail-safe drop.

### D8 — The "easy view": one compact projection, served to agent AND human
A single-line-per-event **transcript skeleton** of how a chat was built — prompt
assembly, thinking, tool calls, timings, sizes — each line collapsing to a summary
(`ai thought 1.8s`, `tool read_file ran 0.5s → ok (2.0k)`), expandable to the
verbatim span. Key realizations:
- **It's a *projection*, not new infra** — a pure `spans → text` formatter in the
  query layer (P2: zero I/O, exhaustively unit-testable). NOT a frontend, NOT a
  graphical timeline (that's out-of-scope frontend later, which can consume the
  same projection).
- **Same artifact for both consumers** — this compact skeleton IS the
  "store-fat-serve-thin" *thin overview* the agent reads first before drilling
  into a span. The human "easy view" is that same text rendered to a terminal/
  markdown. So it *reinforces* agent-first; it does NOT reopen the human-viz
  question (D1) — no heavy infra, no design deformation.
- **One genuinely new capture it forces: prompt-assembly provenance** (see §4) —
  the context-filter chain (§3.2) records each contribution as a *segment* so we
  can show `persona(1180) · tool:read_file(300) · skill:web(400) · user(412)`.
  Cheap: *segmentation metadata over the verbatim body we already store* (D5),
  not a copy.
- **Interlocks with cache debugging (§3.1):** a prefix-fingerprint bust attributes
  to the exact contributor whose segment changed ("skill:web 400→420 between warm
  and real send").
- **Doubles as a completeness test:** if the easy view reconstructs how the chat
  was built end-to-end, the §4 taxonomy captured enough — every skeleton line must
  be backed by a real span/segment.

### D9 — Optimization analytics = derived aggregates, NOT a separate metrics pillar
A third consumption pattern over the SAME spans (after incident-debugging and the
D8 easy view): longitudinal roll-ups to tune Dispatch itself — token size per turn,
model generation time, tool-call durations, tool/skill usage frequency, error
rates. **P4 call: these are `GROUP BY` queries over the span store, not a separate
counters/histograms pipeline.** Everything needed is already a span attribute (turn
tokens, step/tool durations, tool-call counts, `isError`, D8 segment sizes) — no
new capture. (The "metrics pillar" machinery earns nothing here: no dashboards, no
alerting — agent-first.)
- **Cost/benefit interlock (the high-value one):** cross D8 `prompt.assembly`
  segment sizes — the *standing cost* a tool/skill/persona imposes on EVERY turn
  (context budget + cache pressure) — against usage frequency + success — the
  *realized benefit*. Ranks contributors by cost/benefit → directly answers
  "should we keep this tool in the definitions?" A rarely-used tool with a fat
  definition is pure overhead and a cache-bust risk.
- **Objective vs. interpreted:** counts/durations/error-rates are objective SQL.
  "Is the tool's description good enough for the model to know when to use it?" is
  a *hypothesis* an analysis agent forms from those signals + samples (defined but
  never called; called then result ignored; high input-schema error rate) — not a
  pure metric. Agent-interpreted, consistent with agent-first.
- **Retention asymmetry (the one real new requirement):** fat verbatim data (D5)
  rotates out fast; cheap aggregates are rolled up and kept long for trend signal.
  A periodic rollup `scheduledJob` (§2.3 scheduler) writes compact daily/weekly
  summaries that survive raw-trace pruning.
- **Three consumers, one capture:** incident-debug (one trace) · D8 easy view (one
  chat) · D9 analytics (many turns) — all the same spans. The capture is the asset;
  every consumer is a cheap projection/aggregation. Validates the D2 boundary.

### D10 — Logs/spans are a one-way emission, not a feature channel (clarifies D2/D3/§5.4)
Answering "do logs pass through other extensions?": **no.** Two distinct flows that
never mix:
- **Regular (feature) data** — extension→extension via typed contracts / hooks /
  services (§3.5, §5.4): in-band where it matters (filters awaited, services return
  values, the provider stream consumed by the kernel), type-anchored, **affects the
  turn outcome**.
- **Logged (observability) data** — ANY extension → its auto-scoped `host.logger`/
  span → kernel mints the record (stamps `extensionId`/ids/timing; secrets are
  already self-redacted by the source, D5) → `sink.emit` → **journal** →
  out-of-process **collector** → store →
  debugging agent. **One-way, fire-and-forget** (D3/D7): never awaited, never changes
  a turn, swallowed on error.

**Each extension authors its OWN logs** (handle auto-stamped with its id, D4). A
sibling feature extension **never receives** another's logs — that would be feature
coupling *through logs* (an anti-pattern; cross-feature reaction is what hooks are
for). The **sole reader** is the `observability` extension, off the (out-of-process)
collector/store + the in-process **`onAny`** firehose + the AgentEvent tap — the
§5.4 "observability only, never feature code" exception. **Many independent one-way
producers, exactly one privileged consumer** — so logging can never become a
backdoor feature bus.

---

## 3. Validation — the bug catalog (P4: earn it against real failures)

Each row is a real (old-Dispatch) failure → the query/diff that finds it. This is
the acid test that the design pays for itself.

| Failure | How the trace finds it |
|---|---|
| **Chat crashed** | Spans written incrementally → trace ends at the last span before death; collector's EOF stamp shows "process exited after span X". Read the tail. |
| **API rejected corrupted history** | `provider.request` span holds the exact post-transform body + raw rejection; an incomplete tool call is literally a tool-call span with no matching tool-result span; a `reconcile.repair` span shows any auto-fix. |
| **Queued message shown twice** | Two `deliver` spans for one message id (a count query). |
| **Queued message in wrong chat** | The enqueue span's `target.conversationId` ≠ where it delivered; filter by message id across conversations → the misroute is explicit. |
| **Prompt cache returns 0% hit** *(new)* | See §3.1 — diff consecutive verbatim requests' cacheable prefixes; a `prefix.fingerprint` attribute flags the bust; span timestamps reveal a cache-warming gap > TTL. |

### 3.1 Worked example — the prompt-cache 0%-hit bug (cache warming)
**The system (cache warming):** provider prompt caches expire ~5 min. To keep a
chat's cache warm without a user message, periodically **resend the (rewound)
conversation** to refresh the cached prefix — staying warm until the real next
message lands a hit.
**The bug:** occasionally the API reported **0% cache read** with no way to debug
why. Cache hits depend on **byte-exact prefix identity**, so a miss has many silent
causes, all invisible before now:
- the cacheable prefix changed (tool schemas reserialized in different key order; a
  volatile value crept into the system prompt — timestamp/date/nonce; a
  skill/agent injection changed; attachment re-encoded);
- the `cache_control` breakpoint moved or wasn't set;
- the **cache-warming request's prefix wasn't byte-identical** to the prefix the
  next real message extends → you warmed the *wrong* cache;
- provider-side: the warming send fired late (gap > TTL), eviction, model change.

**Why this design nails it:**
- Verbatim capture (D5) of **every** provider request — *including cache-warming
  sends, flagged `warm` vs `real`* — plus **cache-token counts from the response**
  (`cache_read`, `cache_creation`).
- A **`prefix.fingerprint`** attribute (hash of the cacheable prefix up to the
  `cache_control` breakpoint): a cache bust = the fingerprint changed unexpectedly
  between a warming send and the next real send. One grouped query flags it; then
  diff the two bodies to see *which bytes* diverged.
- **Bonus insight this surfaces:** it makes **non-deterministic serialization** (a
  Map's key order, unstable tool-schema generation) — an otherwise invisible
  cache-killer — show up as a visible diff. Capture turns "0% and no idea why" into
  "these 14 bytes of the prefix changed, introduced by transform Y."

---

## 4. Capture taxonomy (draft — the §-next thread)

Span kinds, driven by the bug list (attributes are illustrative, not final):
- **turn** (root) — `conversationId`, `turnId`, model, status, token usage.
- **step** — one LLM round-trip within a turn.
- **provider.request** *(the star, D5)* — verbatim body (post-transform), headers
  (redacted), raw response/error, `cache_control` presence, `prefix.fingerprint`,
  `warm|real`, cache-read/creation tokens, latency.
- **prompt.assembly** *(D8)* — ordered composition segments of the request:
  `{contributor extension.id, kind (persona|tool-def|skill|agent-profile|history|
  user-msg), role, length, contentRef→verbatim body}`. Powers the easy-view
  prompt-assembly render + per-contributor cache-bust attribution.
- **tool-call** — `toolCallId`, name, input, result, isError, duration.
- **reconcile.repair** *(§3.4)* — what the load-time repair changed.
- **queue.enqueue / dequeue / deliver** — message id, source/target conversation,
  links to the turn it caused. *(queue/session-features ext not built yet.)*
- **process.lifecycle** — boot / shutdown / **crash** (collector-synthesized).
- **structured log** — leveled, attributed, correlated line (the evolved Logger).

---

## 5. Vocabulary (user-approved; promote to GLOSSARY.md when this lands)

Approved this session: **trace**, **span**, **attribute**, **structured log**,
**observability**, **redaction**, **debugging agent**. Standard/training-baked —
they cost zero glossary justification (P6).
- **trace** — the full correlated record of one operation (≠ *history*/chunk log).
- **span** — one timed unit of work in a trace (parent + links + attributes).
- **attribute** — typed key/value on a span/log. *(aliases to avoid: tag, field, metadata)*
- **structured log** — a leveled, attributed, correlated record. *(avoid: debug message)*
- **span link** — a causal edge to another span/trace (cross-feature).
- **collector** — the out-of-process sink that normalizes + stores + serves traces.
- **journal** — the append-only durable buffer file between app and collector.
- **cache warming** — periodically resending a (rewound) conversation to keep its
  provider prompt cache warm within the ~5-min TTL. *(aliases to avoid: reheat,
  cache reheating)* — **user-decided.** Distinct from **wake** (the Claude
  wake-probe scheduler in old code) — keep the two concepts separate.
- **redaction** — replacing a secret's middle with `…redacted…`, keeping the first
  3 + last 3 real chars (partial masking — keeps the field present + diffable; never
  dropped). *(aliases to avoid: censoring, scrubbing, masking-as-removal)* —
  technique **user-decided.**

---

## 6. Open threads (not yet decided)

- **Span/attribute vocabulary** — finalize §4 (next up).
- **Structured-`Logger` ABI change** — today it's unstructured `(message,
  ...args)`; evolve to leveled + attributed + auto-scoped + correlated. Kernel
  owns `Logger` → this is an ABI change with `lsp references` fan-out. Decide:
  evolve in place vs. add a parallel structured channel. **Proposed shape: §8**
  (awaiting the A/B call).
- **Retention/rotation sizing** — verbatim bodies are large; TTL + size cap +
  compression; keep successes long enough for diffing.
- **Journal / IPC line protocol** — NDJSON to a pipe vs. unix socket vs. append
  file; framing; backpressure (drop-oldest/sample). **The journal file IS the durable
  queue** — there is **no in-memory log queue** in either process (that's the
  crash-safety win): a normal app crash/OOM does NOT lose already-`write()`-en lines
  (bytes live in the OS buffer, not the process heap); the collector resumes tailing
  from its last offset on restart. *Open:* **fsync cadence** — per-line (durable,
  slow) vs. periodic vs. none (fast); only a kernel-panic/power-loss risks the last
  unflushed line (§3.4 bound).
- **Redaction policy** — *DECIDED:* (b) **short-secret guard** = graduated tiers by
  length: **≥13 → reveal 3** each side · **11–12 → 2** · **8–10 → 1** · **≤7 → full
  mask** (the `10` overlap resolved conservatively to reveal-1; `…redacted…` token is
  fixed-width so it never leaks the hidden length). (c) **who redacts** = **each
  extension self-redacts in isolation — NO shared helper, nothing in the kernel**
  (D5/§9): the producing ext masks in its own code at the call-site. *Still open:*
  (a) the exact secret-field/header list — declared **per-extension** (it knows its
  own; e.g. openai-compat: `authorization` header + any vault-injected body field).
- **Cache-token fields** — *RESOLVED by inspection:* `Usage` already carries
  `cacheReadTokens?` / `cacheWriteTokens?` (`packages/kernel/src/contracts/provider.ts`)
  — **no provider CR needed**; only confirm the openai-compat provider *populates*
  them (instrumentation detail, not a contract gap).
- **Collector supervision** — host-bin spawns first / drains last; restart +
  resume-tail; what if the collector dies.
- **Levels & default capture set** — what's on by default (deltas off).
- **Easy-view rendering (D8)** — the projection format + delivery surface (CLI
  command vs. transport route returning markdown; frontend later), and char-counts
  (free) vs token-counts (needs a tokenizer) in the skeleton.
- **Analytics roll-ups (D9)** — rollup table shape + retention asymmetry (raw
  traces short, aggregates long); `GROUP BY` indexes (tool_name, model, kind, time).
  *(The periodic-job mechanism already exists: `host.scheduler.register` —
  `packages/kernel/src/contracts/extension.ts`; only the table shape + retention +
  indexes remain to design.)*
- **`onAny` firehose (kernel)** — reserved (§5.4) but unbuilt: confirm it's the
  capture tap and define its shape (one listener; payload = hook id + payload +
  correlation).
- **Debugging-agent delivery + the "grab an ID" entry point** — how an id is handed
  to the agent; rides on the (unbuilt) `agents` extension + its P7 harness.
- **Sequencing / dependencies** — build the substrate now (Logger ABI, onAny,
  collector, store, core span kinds); instrument the rest as their features land
  (queue spans ← session-features; `prompt.assembly` ← context-filter chain;
  debugging agent ← agents ext).
- **Extension-logging rule placement** — *DECIDED:* `.dispatch/rules/extension-logging.md`
  (user's call); wired into the ORCHESTRATOR.md §3 scoping map for extension agents.
  Content drafted (§9, tribal-knowledge only); authored when the substrate is built.

## 7. Deferred / out of scope
- Replay-to-reproduce (the data supports it; build later).
- Adversary/multi-tenant isolation (we defend faults, not adversaries — §3.7).
- Human dashboards / metrics viz (agent-first; revisit only if a human need
  appears).

---

## 8. Logger ABI — proposed shape (resolving open-question #1; awaiting A/B)

> **STATUS: proposal, NOT yet decided.** Forced by: structured records ·
> auto-scoped to extension (D4/D6) · explicit correlation / no ambient (P3) ·
> spans (D8/D9) · fire-and-forget non-blocking emit (D3) · sink-injected (purity).

### Proposed types (kernel ABI)
```ts
type Level = "debug" | "info" | "warn" | "error";                              // keep 4 (P6)
type Attributes = Readonly<Record<string, string | number | boolean | null>>;  // flat: serializable (D3) + queryable (D9)

interface LogContext {
  readonly extensionId: string;      // auto-stamped by host (D6) — not caller-supplied
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly spanId?: string;
}

interface Logger {
  readonly debug: (msg: string, attrs?: Attributes) => void;
  readonly info:  (msg: string, attrs?: Attributes) => void;
  readonly warn:  (msg: string, attrs?: Attributes) => void;
  readonly error: (msg: string, attrs?: Attributes & { err?: unknown }) => void;
  readonly child: (ctx: Partial<LogContext> & { attrs?: Attributes }) => Logger; // explicit value, passed down (P3)
  readonly span:  (name: string, attrs?: Attributes) => Span;
}

interface Span {
  readonly id: string;
  readonly log: Logger;                                                          // pre-bound to this span
  readonly setAttributes: (attrs: Attributes) => void;
  readonly addLink: (target: { spanId: string; turnId?: string }, reason?: string) => void; // D4 causal edges
  readonly child: (name: string, attrs?: Attributes) => Span;                    // step → tool-call nesting
  readonly end: (outcome?: { err?: unknown; attrs?: Attributes }) => void;       // records duration + status
}
```

### Why this is P3-safe (the OTel contrast)
`child()` / `span()` return **explicit values you pass down** (orchestrator →
`runTurn` → `ctx.log` into tools). No hidden "current span"; correlation travels
as an argument — exactly why we could drop OTel's `AsyncLocalStorage`.

### Purity story (a "kernel logger" that touches no I/O)
`Logger`/`Span` are **pure record-builders over an injected `LogSink {
emit(record): void }`**. The kernel mints records (auto-stamps `extensionId`,
ids/timing) and calls `sink.emit`; the **sink is a host-bin bootstrap dependency**
(like the storage factory — available before any extension activates, per the
"Logger always available" contract). The sink writes the **journal** (D3); the
observability **collector owns the other end**. Kernel testable with a fake sink,
zero mocks.

### The fork — DECIDE THIS (open-question #1)
- **A — evolve `Logger` in place (recommended).** Replace the string logger; the
  simple call `info("msg")` still compiles (attrs optional) but flows through the
  same correlated logger → **A subsumes B's ergonomics**. Con: ABI fan-out — but
  tiny now (a few `logger.error("...", err)` sites → `{ err }`); only grows later.
- **B — parallel structured channel, keep the string logger.** Zero churn, but two
  paths → drift, and casual `logger.info` stays uncorrelated / invisible to the
  store — defeats "everything queryable" and grates against P8.

### Sub-decisions baked into the sketch
- Inject `{ sink, now, newId }` — deterministic ids/timing in tests (§3.6).
- Flat scalar attributes (nested → stringify) — keeps D9 `GROUP BY`/indexes clean.
- `error(msg, { err })` normalizes today's positional `Error` arg.
- **Downstream contract change:** tools get **`ctx.log`** (span-bound) so they log
  correlated without a global (P3) — a `ToolContract` ctx addition (§3.3 ctx
  already carries `signal`/`onOutput`).

---

## 9. Harness artifact — the extension-logging rule (tribal-knowledge ONLY, P6/P7)

> **Status:** planned deliverable (user-requested). Extension-scoped (P7): the
> knowledge lives in the **harness**, and **each extension implements logging +
> redaction in its OWN isolated code** — there is NO shared logging/redaction helper
> to couple them (P1; isolation over DRY). Loaded by every extension-author agent.
> **Placement DECIDED** (user): `.dispatch/rules/extension-logging.md`, wired into the
> ORCHESTRATOR.md §3 scoping map for extension agents. **Write it when we build the
> substrate, not before.** P6 governs hard: state ONLY what a frontier model would
> get wrong about THIS system; omit anything inferable.

**MUST state (non-inferable, project-specific):**
- **Self-redact your own secrets before logging — in your own code.** There is no
  shared `redact()` and nothing in the kernel does it for you. YOU decide what is
  secret and how to censor it. Default censoring = the §6 tiered partial mask
  (reimplement it locally; deviate if your secret type warrants).
- Use the injected `host.logger` / the span / `ctx.log` you're handed — never
  `console.*`, never a hand-rolled logger or your own correlation ids.
- **Don't set `extensionId` / invent an id scheme** — it is auto-stamped (D4).
- **Attributes are flat scalars** (nested → stringify) — D9 GROUP BY + journal
  serialization need it.
- **Don't log token deltas / per-chunk streaming** (D7) — redundant + noisy.
- **Logs are one-way (D10)** — never read another extension's logs; cross-feature
  reaction is a hook, not a log.
- Edge I/O (providers): capture the request **verbatim, post-transform, at the fetch
  edge** (D5), self-redacting secret headers/fields in your own code.

**Must NOT state (inferable — omit, P6):**
- What logging/levels are for; info/warn/error semantics; "log your errors."
- How to call `logger.info("msg", {attrs})` (obvious from the type).
- Generic "don't log sensitive data" platitudes (replaced by the concrete
  self-redaction rule) or any SQL/GROUP BY explanation.

---

## 10. Build plan — Phase A (logging substrate)

> **Status:** PLANNED, prompts drafted (`prompts/phase-a-{kernel-logging,journal-sink}.md`),
> awaiting final user review before summon. **Goal:** every extension + every turn
> emits structured records durably into the **journal file**. Phase A = **1 process**
> (main app + in-process sink); the collector is process 2 (Phase B). Logger ABI = **A**.

### Record contract — frozen FIRST (both units depend on it)
`packages/kernel/src/contracts/logging.ts` (kernel owns it). Agent finalizes the
exact shape; load-bearing constraints:
- **`LogRecord`** = flat, JSON-serializable **discriminated union**: `log` line |
  `span-open` | `span-close`. Spans emitted **incrementally** (open at `span()`,
  close at `end()`) so a crashed turn is reconstructable from the journal (D3).
  Every variant carries correlation (`extensionId` auto-stamped + optional
  `conversationId`/`turnId`/`spanId`/`parentSpanId`), `timestamp`, flat `attributes`
  (queryable scalars), **and an optional `body` blob** (string) for large verbatim
  payloads — the pre-mutation prompt now, the verbatim provider request later
  (store-fat-serve-thin: query tools serve diffs/slices, not the raw blob).
- **`LogSink { emit(record): void }`** — fire-and-forget; the kernel never lets a
  sink error escape into a turn (D7).
- **`Logger` / `Span`** — the §8 shapes (leveled/attributed/auto-scoped/correlated;
  `child()`/`span()` return explicit values — P3, no ambient).

### Unit 1 — `kernel-logging` (ONE coordinated kernel owner; single-writer over kernel)
Interlocked ABI change (cf. the `tabId→conversationId` rename). Stage commits
(**contract checkpoint → host → runtime**) so the contract freezes early for Unit 2.
Owns: `contracts/logging.ts` (new), `contracts/extension.ts` (evolve `Logger`),
`contracts/tool.ts` (+ `ctx.log`), `contracts/index.ts` (re-export), `host/host.ts`
(+ `logSink` on `HostDeps`, mirroring `storageFactory` @ host.ts:34/60; build each
extension's auto-scoped logger that stamps `manifest.id`) + `host.test.ts`,
`runtime/{run-turn,dispatch}.ts` (open/close turn/step/tool-call spans; thread
`ctx.log`) + tests. **The `step` span records the verbatim pre-mutation prompt**
(messages + tools + opts) in its `body` — the **"BEFORE"** capture. Pure
record-builder injected with `{ now, newId }`.

### Unit 2 — `journal-sink` (bootstrap library, NOT an extension)
`packages/journal-sink/`. Implements kernel `LogSink`: pure `record → one NDJSON
line` core + thin fs append edge + rotation/backpressure (drop-oldest + warn — D3
fail-safe). Imports the frozen `LogRecord`/`LogSink` TYPES; never redefines them.

### host-bin wiring (orchestrator CR)
Construct the sink, add `logSink` to `deps: HostDeps` (main.ts:77) so `host.logger`
works before any extension activates. Root tsconfig ref + host-bin dep on
`@dispatch/journal-sink` + `bun install` + biome import-sort (same wiring as
tool-read-file, Step 2).

### Order & parallelism
Sequential for safety (record type is a hard dep): **Unit 1 (freeze contract →
finish) → Unit 2 → host-bin wiring**. Optional overlap: start Unit 2 once Unit 1's
`logging.ts` checkpoint is committed.

### Open sub-decisions (lock while finalizing prompts)
- Package name `journal-sink` (vs `log-journal`). · fsync cadence (default periodic).
- Journal file path + rotation policy (size cap; on-disk location).
**Verify:** `typecheck`/`test`/`check` clean; live boot → `host.logger` lines land in
the journal file.

### Phase A.2 — the "AFTER" capture (build plan)
`provider.request` verbatim post-transform (D5) inside `provider-openai-compat`:
exact serialized request + response status/cache-tokens/raw-error, auth self-redacted.
Completes full round-trip rebuild + the **before↔after diff**.
- **Contract (DONE, orchestrator):** `ProviderStreamOptions.logger?: Logger`
  (`contracts/provider.ts`) — threads the step's correlated logger into `stream()` so
  the `provider.request` span is a child of the step span (before↔after share
  turnId/parentSpanId). Optional = non-breaking.
- **Unit K — kernel run-turn** (owner: kernel): pass the step span's logger into
  `provider.stream(msgs, tools, { ...opts, logger })`. One file (`runtime/run-turn.ts`).
- **Unit P — provider-openai-compat** (owner): at the fetch edge, if `opts.logger`,
  open a `provider.request` child span; capture the verbatim post-transform request
  (URL, model, params, serialized body) + `cache_control` presence; on response,
  status + cache-read/creation tokens (Usage) + (on error) raw error; **self-redact
  the auth header in its own code** (graduated tiers, §6). First hermetic provider
  HTTP test (`stream.test.ts`, mock `fetch` + real-capture fixtures).
- **Order:** contract frozen (done) → Unit K ∥ Unit P (disjoint: kernel vs provider).

**body-channel ABI — RESOLVED (Phase A.3):** added optional `body?` to
`Logger.span` / `Span.child` / `Span.end` → `LogRecord.body`; and moved `createLogger`
out of `contracts/` so `contracts/logging.ts` is pure types again. The before
(`prompt` span) and after (`provider.request` span) now carry their verbatim payloads
in `body`, not stringified attributes — attributes stay thin/queryable (D9).

*(Full per-extension prompt-segment provenance — D8 — comes later, with the
context-filter chain.)*

---

## 11. Phase B preview — collector flush into SQLite (NOT built; model only)

> Captured so it's not lost; the exact knobs are open Phase B sub-decisions.

The flush into the SQLite **store** is the **collector's** job (process 2), async +
continuous, **decoupled from turns** — the app only appends to the journal and never
waits. Per tick the collector:
1. **Tails** the journal — reads new complete lines since its last committed
   byte-offset (short poll loop or fs-watch).
2. **Batches** them into **one SQLite transaction**, commits.
3. **Advances a persisted consume-offset.**

- **Cadence:** per batch/tick, bounded by *interval OR batch-size, whichever first*
  (e.g. ~250 ms or N records) — never one-txn-per-record (avoids per-record fsync),
  never per-turn. Sub-second / near-real-time.
- **Crash-safety = at-least-once + idempotent:** resume from the persisted offset on
  restart → may re-read a few lines → writes are idempotent (`INSERT OR IGNORE` on a
  record/span id). No loss; harmless reprocess. This is what lets you query a chat
  **after the app that produced it crashed** (D3).
- **Queryability lag** ≈ one batch interval; post-mortem still works (journal is
  durable; the collector consumes whenever it's up).
- **Open (Phase B):** poll vs fs-watch; interval/batch-size; offset storage (store
  metadata vs sidecar); dedup key; + the store schema/indexes (§6).
