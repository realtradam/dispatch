# Glossary — canonical vocabulary

> One name per concept. Never invent a synonym. New term? The orchestrator
> proposes the standard/training-baked name and the user confirms before it lands
> here. "Aliases to avoid" maps wrong names back to the canonical one.

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **kernel** | The minimal runtime core: contracts, extension host, turn loop, event/hook bus. Touches no I/O, names no feature. NOT an extension. | core (when meaning the runtime), engine |
| **core** (tier) | The extension tier required to complete one turn end-to-end ("minimal Dispatch"). | — |
| **standard** (tier) | Extension tier shipped on-by-default; the features people think of as Dispatch. | — |
| **extension** | A unit that contributes capabilities via the Host API: tools, providers, auth, hooks, routes, services, migrations. | plugin, module (when meaning an extension) |
| **contract** | An extension's typed, exported surface: what it exposes + what it requires. The ONLY thing other units see. | interface (when meaning the whole surface), API |
| **manifest** | An extension's declaration: id, version, apiVersion, dependsOn, contributions, capabilities, trust. | — |
| **Host API** | The object an extension receives in `activate(host)`. | host context |
| **conversation** | A single thread of turns with its own persisted history, identified by a `conversationId`. The backend unit of continuity. (The frontend "tab" concept is out of scope for the backend rewrite.) | tab, session, thread, chat |
| **conversationId** | The string identifier for a conversation. Threads multi-turn history; the `/chat` request field that continues an existing conversation. | tabId, sessionId, chatId |
| **turn** | One user message → assistant response cycle (may span multiple steps). | — |
| **step** | One LLM round-trip within a turn (may emit multiple tool calls). | iteration |
| **stepId** | The identifier of a step, stamped on each `tool-call`/`tool-result` event and tool chunk it produces, so a client groups a parallel/batched tool-call set by equality. Branded `StepId`; the runtime derives it deterministically as `<turnId>#<stepIndex>` (0-based). Generation provenance carried ON the tool chunk (unlike `seq`, which is a store-assigned sync cursor on the `StoredChunk` envelope). Treat as opaque. | batchId, step index (as the wire key) |
| **TTFT** (time to first token) | Per-step latency from the generation stream starting to the first content token (text **or** reasoning) arriving. Inherently per LLM round-trip — each step re-prefills, so a turn has one TTFT per step; step 0's is the turn's user-visible first-token latency, and the sum across steps is the total prefill overhead. Captured as observability span timing only (not on the wire). | time-to-first-byte (when meaning tokens) |
| **decode time** | The generation time of a step *after* the first token — first token → stream end, i.e. the step's generation total minus its TTFT. The model's token-production time with first-token latency removed. Observability span timing. | — |
| **turn metrics** | The durable, replayable per-turn metrics record persisted for a sealed turn: aggregate `Usage` (tokens) + turn `durationMs` + its per-step `StepMetrics`. The persisted counterpart of the live `done` event's metrics; persisted per turn by `conversation-store` (returned in turn-append order), served by `GET /conversations/:id/metrics`. Distinct from observability span timing (trace-store) and from transient live wire events. | usage record, turn stats |
| **step metrics** | The durable per-step metrics within a `TurnMetrics`: the step's `Usage` (tokens) + `ttftMs`/`decodeMs`/`genTotalMs` timing. The persisted counterpart of the live `usage` + `step-complete` events, keyed by `stepId`. | step stats |
| **tool call** | A model's request to run a tool within a step. | function call (when meaning a tool call) |
| **chunk** | One ordered piece of a message (text, thinking, tool-call/result, etc.), append-only in the log. | block, segment |
| **seq** | The monotonic, gap-free, per-conversation sequence number stamped on each chunk as it is appended to the log. The sync cursor: a client requests `?sinceSeq=N` to fetch only newer chunks. Storage/sync metadata, never message content. | cursor (when meaning the number), offset, index |
| **StoredChunk** | The wire envelope `{ seq, role, chunk }`: a persisted chunk plus its sync metadata. Keeps the pure `chunk` free of storage concerns while a flat seq-ordered stream stays both syncable and regroupable into messages. | seq'd chunk |
| **content-addressed body** | A verbatim trace `body` stored once in the trace store keyed by its content hash (SHA-256); duplicate bodies (cache-warming resends, any repeat) collapse to a single stored row referenced by hash. The trace store's de-duplication mechanism. | (not fingerprint-keyed) |
| **trace retention** | The trace store's `prune(policy)` pass that bounds storage growth: age-based delete + drop-oldest byte-cap eviction of records/bodies + orphaned-body GC. "Rotation" is one part of retention, not a separate thing. | rotation (as a separate concept) |
| **prefix fingerprint** | A hash of a provider request's cacheable prefix (up to the `cache_control` breakpoint), stamped as a queryable attribute to flag a prompt-cache bust (the fingerprint changed unexpectedly between a warm and a real send). A cache-bust DEBUGGING signal — NOT the body-dedup key. | — |
| **warm vs real (request)** | A `provider.request` flagged `warm` (a periodic rewound resend to keep the prompt cache warm, ≠ `wake`) vs `real` (user-driven). | reheat, cache reheating |
| **runTurn** | The kernel's turn loop: takes provider + messages + tools + dispatch policy, streams, dispatches tools, emits events. | run, agentLoop |
| **hook** | A typed extension point. **event** = fire-and-forget, N listeners, error-isolated. **filter** = ordered value-in→value-out chain, in-band. | callback (when meaning a hook), listener |
| **service** | A single-responder request/response capability fetched via a typed handle. NOT a hook. | — |
| **dispatch policy** | `{ maxConcurrent, eager }` controlling how the turn loop runs a step's tool calls. | — |
| **reconcile** | The pure function run on load that repairs a partial/interrupted turn into a valid history. | recover, repair |
| **session-orchestrator** | The core extension that drives a turn: load history → resolve provider/tools → call `runTurn` → persist. | — |
| **conversation-store** | The core extension persisting the append-only turn/chunk log. | message store |
| **provider** | An extension wrapping an LLM backend (`stream(messages, tools)`), provider-agnostic to the kernel. | — |
| **AgentEvent** | An outward event the runtime emits during a turn (text-delta, tool-call, usage, done, etc.). Carries `conversationId` + `turnId`. | — |
| **credential** | A named profile binding a name to a provider (and holding its key/baseURL). The unit of model addressing; several may exist, even for the same provider. Defined in config (a TOML, later); the MVP hardcodes one named `opencode`. Owned by the `credential-store` extension. | (not the bare **key**) |
| **key** | The API key (the secret string) held by a credential. | apiKey / api-key (when meaning the whole credential profile) |
| **model name** | The selectable identifier in `<credentialName>/<model>` form — what the model catalog lists and what the CLI / `/chat` `model` field take. | model reference, model id |
| **model catalog** | The list of available model names; served by `GET /models`, aggregated per credential from each provider's `listModels()`. | model list |
| **skill** | A reusable instruction document (markdown) under a `.skills/` directory, loaded on demand into the conversation by the `load_skill` tool. Discovered from `~/.skills` (home) and `<cwd>/.skills` (project); on a name clash the cwd skill shadows the home one. A skill's name is its filename without `.md`. | prompt snippet, macro |
| **skill summary** | A skill file's "when to use this skill" line: line 1 of the md, valid only when line 2 is exactly `---`. Advertised (per-turn, cwd-aware) in the `load_skill` tool's description; on load the first two lines are stripped. A file lacking the `---` delimiter shows no summary but stays loadable. | — |
| **tools filter** | The per-turn `FilterDescriptor` (`toolsFilter`, owned by `session-orchestrator`) through which extensions transform a turn's tool set before it reaches `runTurn`. Applied ONCE per turn so the tool definitions stay byte-stable across steps (prompt-cache safe). The first concrete use of the §3.2 context-assembly filter chain. | — |
| **LSP** | Language Server Protocol — the JSON-RPC-over-stdio (`Content-Length`-framed) protocol a `language server` speaks. Used as the adjective for the feature (the `lsp` extension, the `lsp` tool). | — |
| **language server** | A long-lived child process speaking `LSP` over stdio that provides `diagnostics`, hover, definition, references, and symbols for files in a `workspace root`. Spawned lazily, one process per `(serverID, workspaceRoot)`, from a config-resolved definition (command + extensions + root markers + initialization). | LSP server (as the process), lang server |
| **diagnostics** | The errors/warnings/hints a `language server` reports for a file — received both push (`textDocument/publishDiagnostics`) and pull (`textDocument/diagnostic`), then merged + deduped. | lints (when meaning LSP diagnostics) |
| **workspace root** | The directory a `language server` is rooted at (its `rootUri` and spawn cwd): the nearest root-marker ancestor of a file, bounded above by the conversation's `working directory`. | project root (when meaning the per-server root) |
| **working directory** | The per-conversation filesystem directory that tools and `language server`s operate within (`ToolExecuteContext.cwd`). Persisted per conversation by `conversation-store`; gettable/settable via the cwd endpoint; defaults a turn's cwd when `/chat` omits it. | cwd (spell out on first use), workdir (when meaning the conversation's directory) |
| **reasoning effort** | The per-request thinking-depth knob: how much extended thinking the model spends before answering. Ladder `low \| medium \| high \| xhigh \| max` (`ReasoningEffort` in `@dispatch/wire`). Resolution per turn: `ChatRequest.reasoningEffort` override → persisted per-conversation value → default `high`. Each provider maps a level to its native knob in its own code (e.g. Anthropic `thinking.budget_tokens`); providers without such a knob ignore it. | thinking level, effort level, thinking budget (that's the provider-NATIVE knob a level maps to) |
| **context size** | The number of tokens a conversation currently occupies: the most recent turn's FINAL step `inputTokens + outputTokens` (NOT the aggregate per-turn `usage`, which sums per-step prompts and overcounts a multi-step turn). Stamped on `TurnDoneEvent.contextSize` (live) + `TurnMetrics.contextSize` (persisted); a client reads the LATEST turn's value as current usage. Distinct from the model's **context window** (its max token limit — a later feature). | context window (when meaning current usage), context length, tokens used, context usage |

## Known vocabulary drift

- _None._ The former `tabId` drift in `AgentEvent`s and `RunTurnInput` was fully
  resolved (renamed to `conversationId` across contracts + every consumer; see
  tasks.md Step 4). `tabId` is retained only in the "Aliases to avoid" column
  above so it is never reintroduced.
