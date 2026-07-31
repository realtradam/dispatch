# Agent Management Tools and Vision Isolation Plan

> **Status:** Design proposal; no feature implementation has begun.
> **Scope:** Dispatch backend plus the backend-owned skills/orchestration documentation that teaches
> agents how to use the capability. The existing CLI remains supported.
> **Decision ownership:** Extension granularity and new canonical vocabulary are user decisions under
> `ORCHESTRATOR.md` §§5.2/5.6. Names marked **provisional** below must not be added to `GLOSSARY.md`
> or code until the user confirms them.
> **Architecture constraints:** `AGENTS.md`, `ORCHESTRATOR.md`, `GLOSSARY.md`, and
> `notes/restructure-plan.md` P1–P8 are hard constraints, not style suggestions.

---

## 1. Requested outcome

Dispatch should expose a first-class AI-callable tool family for starting and managing other
agent conversations. The tools should provide capabilities analogous to the existing `dispatch`
CLI while avoiding the current requirement that an agent load a skill, construct a shell command,
parse terminal output, and know its workspace id manually.

The requested behavior is:

1. Keep the existing CLI for humans, scripts, recovery, and fallback use.
2. Add tools through which an agent can summon and manage agent conversations.
3. Default a newly summoned agent to the calling conversation's current workspace.
4. Preserve useful CLI capabilities: model selection, task text, attached files, working directory,
   computer, reasoning effort, title, opening the frontend conversation, waiting, queueing,
   reading, listing, sending, queueing, and opening.
5. Make vision consultations hard-isolated: a consultation agent receives no tools and can only
   answer with text.
6. Never advertise `consult_vision` to a vision-capable model.
7. Let a vision-capable model choose and inspect an image file during its own turn.
8. Split implementation into dependency-topological, single-owner units with disjoint file
   ownership wherever possible.

---

## 2. P1–P8 design constraints

| Principle | Constraint imposed on this feature |
|---|---|
| **P1 — Feature-as-a-library** | Agent management is a separately importable standard extension with a small typed service. It is not embedded in the kernel or inflated into `session-orchestrator`. |
| **P2 — Functional core / imperative shell** | Argument validation, default resolution, access decisions, result formatting, and lifecycle decisions are pure. Conversation-store, filesystem, event-bus, and turn effects are injected. |
| **P3 — No ambient state** | Caller workspace, working directory, computer, lineage, and tool policy are explicit inputs or resolved through injected stores. No frontend-selected workspace, process-global “current agent,” or mutable singleton is consulted. |
| **P4 — Earn each mechanism** | Build only the management operations already justified by CLI parity and vision isolation. Do not add general workflows, DAG schedulers, agent pools, role systems, or autonomous retries in this milestone. |
| **P5 — Repo as harness** | Update the skill and orchestration documentation so future agents prefer tools without losing CLI recovery knowledge. |
| **P6 — Document only non-inferable facts** | Document inheritance, access, blocking, tool-policy, and vision-isolation guarantees. Do not add generic instructions about delegation or tool calling. |
| **P7 — Extension-scoped harness** | Agent-management-specific behavior belongs with the new extension/skill; vision behavior stays with `vision-handoff`. |
| **P8 — Canonical vocabulary** | Reuse `conversation`, `conversationId`, `turn`, `workspace`, `working directory`, `model name`, `message queue`, and `steering`. Human-confirm the new `subagent`/`agent management` terms before glossary/code adoption. |

The kernel remains provider-agnostic, tool-agnostic, I/O-free, and unaware of agent management or
vision as concrete features.

---

## 3. Provisional vocabulary and boundary decisions

### 3.1 Recommended vocabulary — user confirmation required

| Concept | Provisional canonical term | Rationale |
|---|---|---|
| A conversation started by an agent for a delegated task | **subagent** | Common agent-system term and matches the user's wording. The actual durable runtime entity remains a `conversation`; “subagent” describes its relationship to a parent. |
| The feature that starts and controls related conversations | **agent management** | Standard umbrella term covering summon, list, read, send, open, and cancel. |
| The new extension/package | **`agent-management`** | Broader than the earlier summon-only `agent-summon` proposal and accurately owns the full family. |
| Start action/tool | **`summon_agent`** | Keeps the user's requested language and is distinct from continuing an existing conversation. |

Proposed glossary entry after confirmation:

> **subagent** — a conversation started by an agent to perform a delegated task. It has its own
> model, history, workspace assignment, working directory, computer, and tool policy. The parent
> relationship is metadata; the durable execution unit remains a `conversation`.

Aliases to avoid should include `child session`, `worker agent`, `spawned chat`, and `agent tab`.

### 3.2 Recommended extension boundary — user confirmation required

Create a new **standard** extension, provisionally `packages/agent-management/`.

Do not add this feature to `session-orchestrator`:

- `session-orchestrator` is a core extension responsible for driving one turn.
- The architecture explicitly keeps subagents outside the kernel.
- Starting/managing related conversations is optional standard-tier behavior.
- A separate extension is independently importable and removable.
- `vision-handoff` can consume a typed management service rather than duplicate conversation
  creation and waiting behavior.

The extension contributes the AI tools and exports a typed `AgentManagementService` service handle.
The CLI stays in `packages/cli/` and remains an HTTP client. Both reach the same underlying
orchestrator behavior, but they do not share a new runtime helper package merely for DRYness.

---

## 4. Target architecture

```text
Human / scripts
    |
    v
existing dispatch CLI ---> HTTP transport ---> session-orchestrator ---> runTurn

Parent agent
    |
    v
agent-management tools ---> AgentManagementService -------------------> session-orchestrator
                                  ^       |                                  |
                                  |       +--> conversation-store           +--> conversation-store
                                  |       +--> injected filesystem/event bus
                                  |
vision-handoff ------------------+
```

Key boundaries:

- **Kernel:** generic contract additions only; no agent or vision names, no I/O.
- **conversation-store:** owns durable conversation metadata, including tool policy and lineage.
- **session-orchestrator:** owns turn start/queue/single-flight and final per-turn tool assembly.
- **agent-management:** owns management policy, tool schemas, parent-scoped authorization, file
  composition, waiting/result collection, and frontend-open requests.
- **vision-handoff:** owns vision capability decisions, image lifecycle, `consult_vision`, and the
  proposed native `read_image` behavior.
- **CLI:** remains an independent HTTP client and recovery surface.

Every cross-extension dependency uses an exported typed service handle or hook descriptor. No
consumer performs a raw string-keyed service lookup.

---

## 5. Agent-management service contract

The exact public type names are provisional, but the behavioral surface should be:

```ts
interface AgentManagementService {
  listModels(input: ListModelsInput): Promise<ListModelsResult>;
  summon(input: SummonAgentInput): Promise<SummonAgentResult>;
  list(input: ListAgentsInput): Promise<ListAgentsResult>;
  read(input: ReadAgentInput): Promise<ReadAgentResult>;
  send(input: SendAgentInput): Promise<SendAgentResult>;
  cancelMessage(input: CancelAgentMessageInput): Promise<CancelAgentMessageResult>;
  open(input: OpenAgentInput): Promise<OpenAgentResult>;
}
```

Each input includes an explicit `callerConversationId` supplied by the tool implementation from
`ToolExecuteContext`. The service resolves caller context and enforces access; callers cannot forge
it through model-provided arguments.

The service is useful independently of AI tools:

- `vision-handoff` uses `summon` with a restricted tool policy.
- Future extensions can summon/manage conversations without invoking a CLI process.
- Tests can inject the effects and exercise pure management decisions.

The `SummonAgentInput` type has a wider surface than the `summon_agent` AI tool schema in
§6.2. The tool schema is what models call and stays narrow. The service method is what
extensions like `vision-handoff` call programmatically and accepts two additional fields not
exposed to models:

- `systemPrompt?: string` — an explicit system prompt override, essential for vision
  consultations that need a focused prompt instead of the default workspace system prompt.
- `images?: readonly ImageInput[]` — image attachments for vision consultations.

The `summon` algorithm must be executed in this exact order:

1. Generate a new `conversationId` (UUID).
2. Resolve the caller's effective workspace, working directory, and computer from the
   conversation store.
3. Persist `parentConversationId` and `toolPolicy` to the conversation store **before**
   calling `startTurn`, so the `toolsFilter` chain can read them during the first turn's
   tool assembly.
4. Call `orchestrator.startTurn(...)` with the resolved parameters. The orchestrator's
   existing new-conversation setup path (which detects `meta === null`) handles workspace
   initialization, title, and system-prompt construction.
5. Return the conversation ID, workspace ID, status, and started flag.

This order is critical: if lineage or tool policy are persisted after the turn starts, the
first turn's tool filtering would not see the policy yet.

The contract should document behavior and guarantees, not only shapes:

- inheritance order;
- blocking semantics;
- access scope;
- whether an operation starts, queues, or waits for a turn;
- cancellation behavior;
- result-size limits;
- error taxonomy;
- durable lineage and tool-policy guarantees.

---

## 6. AI-callable tool family

Use several focused tools instead of one `agent` tool with an action discriminator. Focused tools
have smaller schemas, clearer model selection, and less validation ambiguity. Tool names are
runtime data, so name-based kernel dispatch remains the sanctioned exception to typed-symbol
coupling.

### 6.1 `list_agent_models`

Returns the model catalog available for `summon_agent`.

```ts
list_agent_models({
  query?: string,
  vision?: boolean,
  limit?: number
})
```

Semantics:

- Read the catalog through the existing typed `credential-store` service; do not call the HTTP
  endpoint or CLI from inside the extension.
- Return exact model names suitable for the `model` field, plus available metadata such as
  context window and vision capability.
- `query` is a case-insensitive bounded filter over model name/display name.
- `vision` optionally restricts results by authoritative model metadata with the established
  heuristic fallback only where metadata is absent.
- Enforce bounded default/max result counts and stable catalog order.
- Do not expose credential secrets or provider-internal configuration.

This closes a usability gap in the CLI parity story: an agent should not need `run_shell` and
`dispatch models` merely to discover a valid model name.

### 6.2 `summon_agent`

Starts a new conversation and its first turn.

```ts
summon_agent({
  model: string,
  task: string,
  files?: string[],
  cwd?: string,
  workspaceId?: string,
  computerId?: string,
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max",
  title?: string,
  wait?: boolean,
  open?: boolean,
  toolAccess?: "all" | "none"
})
```

Recommended first-version scope for `toolAccess` is only `all | none`. The underlying persisted
policy may support allow/deny lists, but exposing arbitrary tool names to models is not required
for CLI parity and can wait for a concrete consumer.

The `summon_agent` tool schema above is the narrow surface exposed to models. The
`AgentManagementService.summon` method (§5) accepts two additional fields not shown here:
`systemPrompt` (an explicit system prompt override used by `vision-handoff` for consultations)
and `images` (image attachments for vision consultations). These are service-level fields for
programmatic callers, not AI-callable parameters.

Semantics:

- `model` is required and must be an exact model name from the catalog.
- `task` is required.
- `files` matches repeatable CLI `--file`: read each file as UTF-8 and compose deterministic,
  labelled text after `task`. It does not attach image files; image inputs use the service-level
  `images` field consumed by `vision-handoff`.
- `workspaceId` defaults to the caller's persisted workspace.
- `cwd` defaults to the caller's effective working directory.
- `computerId` defaults to the caller's effective computer.
- `reasoningEffort` follows the normal orchestrator default when omitted.
- `wait` defaults to `false`.
- `open` defaults to `true`.
- `toolAccess` defaults to `all` for ordinary subagents.
- The new conversation stores `parentConversationId` and tool policy before its provider turn
  begins, using the orchestrator's safe new-conversation setup sequence.

Non-waiting result:

```json
{
  "conversationId": "...",
  "workspaceId": "dispatch",
  "status": "active",
  "started": true
}
```

Waiting result additionally includes the final assistant text and final status. The returned text
is capped; the complete answer remains in the child conversation.

### 6.3 `list_agents`

Lists manageable conversations, defaulting to the caller's current workspace.

```ts
list_agents({
  workspaceId?: string,
  status?: ("active" | "queued" | "idle" | "closed")[],
  relationship?: "children" | "descendants" | "workspace",
  query?: string,
  limit?: number
})
```

Recommended defaults:

- workspace = caller workspace;
- relationship = `children`;
- status = active, queued, and idle;
- bounded default/max result count;
- newest activity first.

Returned fields should be concise: full conversation ID, short ID, title, model, status, workspace,
parent ID when present, created/updated time, and whether the caller may manage it.

The tool must not reproduce the CLI's terminal table; it returns stable machine-readable JSON text.

### 6.4 `read_agent`

Reads an agent's latest response or status without replaying its full stream.

```ts
read_agent({
  conversationId: string,
  wait?: boolean,
  maxChars?: number
})
```

Semantics:

- Short ID prefixes of at least four characters are accepted within the caller's authorized scope.
- Ambiguous prefixes return candidates rather than selecting arbitrarily.
- `wait` defaults to `false`; when true, wait until the active turn settles or the parent turn is
  cancelled.
- Return final status, last assistant text, truncation flag, and conversation ID.
- Do not return private reasoning text. The kernel persists reasoning as a distinct
  `ThinkingChunk` type (`type: "thinking"`), separate from `TextChunk` (`type: "text"`). The
  implementation reads the last assistant message from the conversation store via `load()` and
  selects only chunks where `type === "text"`, which structurally excludes thinking — no
  explicit reasoning-stripping logic is needed. This mirrors the existing
  `extractLastAssistantText` precedent in `packages/transport-http/src/logic.ts` and the
  `GET /conversations/:id/last` endpoint's subscribe-wait-load pattern. The filtering lives as a
  pure helper in `agent-management/src/pure.ts` (not imported from transport-http, to avoid an
  unnatural standard-extension → HTTP-transport dependency). The store itself returns all chunk
  types; the text-only selection is a policy decision that belongs to the `read_agent`
  implementation. For `wait: true`, the service subscribes before checking `isActive`, awaits
  `turn-sealed` with timeout and `AbortSignal` propagation, unsubscribes in `finally`, then loads
  from the store and extracts — the same race-free pattern as the existing HTTP endpoint.

### 6.5 `send_agent_message`

Sends a message to an existing managed conversation.

```ts
send_agent_message({
  conversationId: string,
  message: string,
  files?: string[],
  wait?: boolean,
  open?: boolean
})
```

The message is delivered the same way a user message is: if the target conversation is idle,
a new turn starts; if it is active, the message is queued for steering. There is no delivery
mode parameter — the orchestrator's existing behavior handles both cases automatically.

- `wait` defaults to `false`. When the message starts a new turn (target was idle), `wait: true`
  waits for that turn to settle. When the message is queued (target was active), `wait: true` is
  rejected in the first version: the existing message-queue contract exposes a stable queued-message
  ID but not an end-to-end "this queued message caused this later turn" correlation. Inventing that
  correlation inside agent management would duplicate queue ownership. A future message-queue
  contract change may enable correlated queued-message waiting; until then the parent uses
  `read_agent` after queue delivery.
- `open` defaults to `false` for follow-ups.
- The conversation's persisted workspace, model, tool policy, and computer remain authoritative.

### 6.6 `cancel_agent_message`

Cancels one queued message previously returned by `send_agent_message`.

```ts
cancel_agent_message({
  conversationId: string,
  messageId: string
})
```

This delegates to the existing message-queue cancellation contract. It is idempotent: if the
message was already delivered, cancelled, or never existed, return `cancelled: false` and the
post-operation queue snapshot. It cannot retract steering that has already been injected into a
turn. Target authorization is the same as for `send_agent_message`.

### 6.7 `open_agent`

Signals connected frontends to open/focus a managed conversation.

```ts
open_agent({ conversationId: string })
```

The service resolves the conversation's persisted workspace before emitting the existing typed
`conversationOpened` hook. The backend signals; the frontend decides how to render/focus it.

### 6.8 Operations deliberately excluded

The CLI capabilities covered by this family are summon/chat, list, read, send/queue, open,
and cancel. Exclude these until separately justified:

- stop active generation (use the CLI or frontend for this);
- compact a conversation (use the CLI or existing smart-compaction for this);
- delete/close conversation;
- move a conversation between workspaces;
- mutate a conversation's persistent model, working directory, computer, or reasoning effort;
- arbitrary history reads or transcript export;
- kill descendants recursively;
- agent pools, dependency DAGs, retries, budgets, voting, or consensus workflows;
- exposing child reasoning streams to parents.

This stopping point satisfies P4 while still delivering the requested broader family.

---

## 7. Parent scope, lineage, and authorization

Without an access rule, any prompted model could list or control every conversation on the server.
The CLI is a trusted local client; an AI-callable management tool is not equivalent. The tool
family therefore needs a defined scope.

### 7.1 Durable lineage

Persist optional `parentConversationId` as conversation metadata when `summon_agent` creates a
conversation. This supports:

- direct-child and descendant queries;
- default authorization;
- observability;
- frontend relationship rendering later without changing the runtime concept;
- recursion/depth limits if a concrete need appears.

Legacy and human-created conversations have no parent.

Lineage is metadata only. It does not change append-only conversation history or the meaning of a
conversation.

### 7.1.1 Compaction and lineage preservation

Compaction creates a replacement conversation with a new ID, linked back to the source via the
existing `compactedFrom` field. The replacement must inherit `parentConversationId` and
`toolPolicy` from the source conversation. If the parent link is lost, the parent agent can no
longer find or manage the child through `list_agents`, and the authorization check fails because
the lineage chain is broken. If the tool policy is lost, a `toolPolicy: none` conversation (such
as a vision consultation) regains all tools after compaction, defeating the vision isolation
guarantee — a restricted descendant could escape its restrictions merely by being compacted.

This applies regardless of how compaction is triggered: the `smart-compaction` package, the CLI,
or any future mechanism. The compaction owner must copy `parentConversationId` and `toolPolicy`
from the source to the replacement.

### 7.2 Recommended AI access policy

By default, an agent-management tool caller may manage:

1. Conversations it directly summoned.
2. Descendants of those conversations.
3. Its own conversation for read/open only—not send/cancel itself from inside its active
   turn.

Workspace-wide listing or control should require an explicit argument and a separately documented
policy. My recommendation for the initial release is:

- `list_agents relationship: workspace` may list concise metadata in the caller's workspace.
- Mutating operations remain limited to descendants.
- Cross-workspace operations are allowed only for descendants the caller created there.
- A requested workspace override must reference an existing workspace; AI tools do not auto-create
  typo workspaces.

This is product safety and predictable scoping, not a claim of a hostile-extension sandbox. The
project's current threat model still treats installed extensions as trusted.

### 7.3 Short-ID resolution

Resolve prefixes only inside the caller's authorized candidate set. This prevents a short prefix
from leaking or selecting an unrelated conversation. Full IDs are still authorization-checked.

### 7.4 Self-management and cycles

- `summon_agent` always creates a new ID, so lineage cycles cannot arise there.
- Do not provide a public operation that rewrites parent IDs.
- Reject `send_agent_message`/`cancel_agent_message` targeting the caller's currently active
  conversation; self-steering already has the message queue and user input paths.
- No fixed recursion-depth cap is required initially unless provider cost incidents justify it.
  Persisted lineage makes one addable later without ABI redesign.

---

## 8. Waiting, cancellation, concurrency, and result limits

### 8.1 Non-blocking by default

Every operation capable of starting generation defaults to non-blocking. The tool returns promptly
with the conversation ID and state so the parent can continue or explicitly call `read_agent`.
This avoids consuming a tool execution slot for an arbitrarily long child turn.

### 8.2 Blocking behavior

`wait: true` uses orchestrator subscription, not polling and not the CLI. It waits for the relevant
turn's terminal event and collects only assistant text/error/status. It must:

- subscribe without missing events emitted between start and subscription;
- unsubscribe in all completion, error, timeout, and abort paths;
- propagate the parent tool's `AbortSignal` to waiting only;
- not automatically stop the child when the parent stops, unless a future explicit option adds
  coupled cancellation;
- enforce a configurable maximum wait duration;
- cap returned text and indicate truncation.

The child remains a durable independent conversation even when waiting is cancelled.

### 8.3 Provider concurrency

The child uses the existing provider-concurrency extension and normal oldest-agent-first behavior.
Agent management must not implement a second concurrency scheduler.

### 8.4 Tool dispatch safety

Management operations modify separate conversations but may conflict when called in parallel for
the same target. Mark mutating management tools `concurrencySafe: false` unless the service itself
provides target-keyed serialization. Prefer the simple safe declaration first; optimize only if
real workloads show a bottleneck.

### 8.5 Error taxonomy

Define stable result categories in the service contract, then format them for tools:

- invalid input;
- unknown or ambiguous conversation;
- forbidden target;
- unknown model;
- workspace not found;
- queue unavailable;
- wait timeout;
- caller cancelled;
- child turn/provider failure.

Expected operational failures return tool errors; extension bugs may throw and are contained by
normal extension-boundary handling.

---

## 9. File attachment behavior

The CLI's `--file` means “read text and fold it into the message.” The management tools should
preserve that exact semantic for `files`:

- resolve relative paths against the effective child/target working directory;
- use the selected local or remote execution backend;
- enforce working-directory containment;
- reject directories, binary files, unreadable files, and files above a configured size;
- keep argument order and deterministic labels;
- do not log file contents;
- do not add a shared CLI/extension helper package merely to deduplicate composition logic.

Vision images are different. `vision-handoff` calls the typed service with `images`, which is not
exposed as raw data URLs in the public AI tool schema.

---

## 10. Durable conversation tool policy

A prompt saying “do not use tools” is not enforcement. Vision consultation requires a provider
request with no tool definitions, including on every follow-up turn and after restart.

### 10.1 Policy contract

Persist a generic conversation policy, provisionally:

```ts
type ConversationToolPolicy =
  | { readonly mode: "all" }
  | { readonly mode: "none" }
  | { readonly mode: "allow"; readonly names: readonly string[] }
  | { readonly mode: "deny"; readonly names: readonly string[] };
```

The initial management tool exposes only `all | none`; allow/deny supports internal focused agents
and future user-facing policy without another persistence migration.

Ownership:

- `conversation-store` owns persistence and the exported typed contract.
- `session-orchestrator` resolves/applies the policy.
- `agent-management` selects an initial policy during summon.
- `vision-handoff` requests `none` through `AgentManagementService`.
- the kernel receives only the final resolved tool array.

### 10.2 Assembly order and enforcement

For each turn, `session-orchestrator`:

1. resolves registered base tools;
2. runs the existing extension-owned tools filter once;
3. applies the persisted conversation tool policy **last**;
4. passes the final stable list to `runTurn` for all steps.

Applying the policy last guarantees a later extension filter cannot reintroduce a tool into a
`none` conversation.

The enforcement mechanism is the existing `toolsFilter` chain in `session-orchestrator`. The
`agent-management` extension registers a filter handler in this chain at activation time using
the sanctioned `host.addFilter` pattern (the same pattern used by
`filterRemoteIncompatibleTools`). The filter reads the conversation's persisted `toolPolicy`
from the conversation store and filters the tool set accordingly: `mode: "none"` returns an
empty set; `mode: "all"` passes everything through; `mode: "allow"` intersects with the listed
tool names; `mode: "deny"` removes the listed tool names. The filter runs once per turn during
tool assembly, preserving byte-stable tool definitions across steps within the turn.

### 10.3 Conversation-store contract changes

Persisting `parentConversationId` and `toolPolicy` requires new fields and methods on the
conversation store and the wire type. The current `ConversationMeta` has `id`, `createdAt`,
`lastActivityAt`, `title`, `status`, `workspaceId`, and `compactedFrom?` — no parent or
tool-policy field. The following must be added:

New `ConversationStore` methods:

```ts
readonly setParentConversationId: (conversationId: string, parentId: string) => Promise<void>;
readonly getParentConversationId: (conversationId: string) => Promise<string | null>;
readonly setToolPolicy: (conversationId: string, policy: ConversationToolPolicy) => Promise<void>;
readonly getToolPolicy: (conversationId: string) => Promise<ConversationToolPolicy | null>;
```

New optional fields on `ConversationMeta` (wire type):

```ts
readonly parentConversationId?: string;
readonly toolPolicy?: ConversationToolPolicy;
```

New storage keys: `conv:{id}:parent` and `conv:{id}:toolpolicy`.

Legacy conversations without these fields resolve to `parentConversationId: null` and
`toolPolicy: { mode: "all" }` for backward compatibility.

### 10.4 Creation ordering

The initial tool policy enters through `StartTurnInput` and is persisted during normal
new-conversation setup. It must not create conversation metadata before the orchestrator's newness
check; doing so could skip workspace setup and first-turn system-prompt construction, the same
ordering hazard already documented for titles.

Legacy conversations without policy data resolve to `all` for backward compatibility.

---

## 11. Vision consultation hard isolation

Refactor `vision-handoff` to consume the typed `AgentManagementService` instead of owning a second
conversation-start/wait implementation.

A consultation request supplies:

```ts
{
  model: selectedVisionModel,
  task: question,
  images,
  inheritedWorkspaceId,
  inheritedCwd,
  inheritedComputerId,
  wait: true,
  open: true,
  toolPolicy: { mode: "none" },
  systemPrompt: focusedVisionPrompt
}
```

Guarantees:

1. The consultation conversation has durable `toolPolicy: none`.
2. The provider receives `tools: []` on the first and all later turns.
3. The focused system prompt asks for a direct textual answer; it is guidance, not enforcement.
4. The parent receives only final answer text or a typed error, never child reasoning or tool data.
5. The child inherits the caller's workspace, working directory, and computer unless explicitly
   overridden by the trusted `vision-handoff` service call.
6. The conversation remains independently viewable and usable, but every follow-up remains
   tool-free after restart.

“Text-only” here means no tool calls or executable actions and only assistant text returned to the
parent. Provider-native reasoning may still appear in the consultation UI unless a separate
render/privacy decision suppresses it; that is not conflated with tool isolation.

---

## 12. Model-aware vision tool filtering

`consult_vision` should never be advertised to a model that can see images itself.

Extend `ToolAssembly` with the resolved `modelName`. The `vision-handoff` extension registers a
model-aware tools filter:

| Resolved capability | `consult_vision` | `read_image` |
|---|---:|---:|
| vision-capable | hidden | available |
| non-vision | available | hidden |
| unknown metadata | existing name heuristic decides | complement of that decision |

`ModelInfo.vision` remains authoritative when present; the existing model-name heuristic is a
fallback only.

This remains outside the kernel. The kernel names neither tool nor vision capability. The filter
runs once per turn, preserving byte-stable tool definitions across steps and prompt-cache safety.

A `toolPolicy: none` conversation still receives neither tool because final policy application
runs after the filter.

---

## 13. Vision models choosing filesystem images

### 13.1 Recommended boundary — user confirmation required

Add a provisional `read_image` tool inside `vision-handoff`, rather than creating a separate
`tool-read-image` extension.

Rationale:

- `vision-handoff` already owns model vision detection, temporary image storage, compact URL
  resolution, image limits, transcriptions, and cleanup.
- A separate extension would duplicate image lifecycle logic or add coupling solely for DRYness.
- The tool is meaningful only under the extension's model-aware filter.

This is the recommended application of P1/P4, but extension granularity remains user-owned.

### 13.2 Tool behavior

```ts
read_image({ paths: string[] })
```

The tool:

1. resolves each path against `ToolExecuteContext.cwd`;
2. uses `ToolExecuteContext.computerId` to select the injected local/remote execution backend;
3. enforces working-directory containment;
4. validates regular file, supported image MIME/extension, per-image size, total size, and count;
5. returns concise text metadata plus native image attachments;
6. allows the same vision-capable agent to inspect the images on the next model step.

Initial scope supports filesystem paths on the active computer. Arbitrary HTTP image URLs are
deferred because they add SSRF/network-policy questions without being required by the stated use
case.

---

## 14. Generic multimodal tool-result support

Today a tool result is text only. Writing a data URL into that text does not cause a vision model
to see an image. Add a generic kernel ABI capability without naming `read_image`:

```ts
interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  readonly images?: readonly ImageInput[];
}
```

### 14.1 Pure kernel runtime behavior

After a step with tool calls:

1. append all tool-role result messages in call order;
2. then append deterministic user-role image messages for results with images;
3. begin the next provider step.

All tool results must precede synthetic user messages so providers that require a complete parallel
tool-call/result batch remain valid. Ordinary text-only tools remain byte-stable.

The kernel performs no file read, URL resolution, persistence, or image compaction.

### 14.2 Persistence and event behavior

During the active turn, data URLs may stay in memory so the next provider step sees them. Before
incremental persistence, `session-orchestrator` passes image chunks through the injected existing
image-storage service so SQLite stores compact temporary URLs rather than base64 payloads.

Later turns resolve compact URLs at the vision handoff edge as they do for user-attached images.

Do not emit base64 in `tool-result` events. Events may report attachment count/metadata; provider
input and persisted conversation chunks carry the actual images.

---

## 15. Tool-to-CLI capability map

| Existing CLI behavior | AI tool |
|---|---|
| `dispatch models` | `list_agent_models` |
| `dispatch <model> --text ...` | `summon_agent` |
| `--file` | `summon_agent.files` / `send_agent_message.files` |
| `--cwd` | inherited by default; explicit `cwd` where meaningful |
| `--workspace` | inherited by default; `workspaceId` override on summon/list |
| computer selection | inherited by default; `computerId` on summon |
| `--effort` | `reasoningEffort` |
| `--title` | `title` on summon |
| foreground stream | `wait: true` returns final text only |
| background process | default `wait: false` |
| `--open` / `dispatch open` | `open` or `open_agent` |
| `dispatch list` | `list_agents` |
| `dispatch read` | `read_agent` |
| `dispatch send` | `send_agent_message` (automatic: idle starts turn, active queues) |
| `dispatch send --queue` | `send_agent_message` (same tool; queueing is automatic when active) |
| queued-message cancellation endpoint | `cancel_agent_message` |
| `dispatch stop` | deliberately unavailable to parent agents (use CLI) |
| `dispatch compact` | deliberately unavailable to parent agents (use CLI) |
| `--show-reasoning` | deliberately unavailable to parent agents |

The CLI remains the fallback when tools are unavailable, for human terminal use, and for recovery
outside a model turn.

---

## 16. Observability and sensitive data

The agent-management extension uses injected `host.logger`/`ctx.log` only.

Recommended spans/events:

- `agent-management.summon` — parent ID, child ID, model name, workspace, wait/open flags;
- `agent-management.list` — caller ID, scope, result count;
- `agent-management.read` — caller/target IDs, wait, truncation;
- `agent-management.send` — caller/target IDs, wait;
- `agent-management.open`;
- waiting duration and final status.

Do not put task/message/file content, API keys, image data, or child response bodies in scalar log
attributes. If request/response body capture is justified later, the owning extension self-redacts
at its own edge. Logging never blocks or controls another extension.

Persisting lineage gives enough correlation without inventing a second correlation-ID scheme.

---

## 17. Implementation units and dependency-topological waves

Each unit below has one owner-agent and may edit only its assigned package. The orchestrator owns
kernel contract changes, root build/config wiring, and harness/docs. Agents read sibling public
surfaces only. A needed sibling implementation read is a contract gap.

### Decision gate — before feature code

The user confirms:

1. `subagent`, `agent management`, `agent-management`, and tool names;
2. new standard extension versus extending an existing extension;
3. `read_image` inside `vision-handoff` versus a separate extension;
4. access policy, workspace override, and defaults;
5. whether vision reasoning is merely not returned to the parent or also hidden in its own UI.

Then the orchestrator updates the glossary/plan and pre-authors shared contracts.

### Wave 0 — orchestrator-authored contracts and harness briefs

**Owner:** orchestrator only.

- Add generic optional image attachments to the kernel `ToolResult` contract.
- If needed, add only generic image-result chunk/event metadata; never a concrete feature name.
- Pre-author typed conversation policy/lineage surfaces in the owning package's public contract or
  agree the exact producer-owned surface before summoning consumers.
- Write one task prompt per package and attach only matching scoped rules.
- Run `lsp references` on every changed exported symbol to compute the consumer fan-out.

This wave fixes contracts before producer/consumer implementation and widens later parallel waves.

### Wave 1 — independent foundations

#### Unit A: kernel runtime

**Owns:** `packages/kernel/`

Job:

- Thread generic `ToolResult.images` into the next provider step.
- Preserve tool-result ordering for parallel calls.
- Keep text-only behavior byte-stable.
- Perform no I/O and name no concrete feature.

Required tests:

- existing text-only regression;
- single and multiple image results;
- parallel calls: all tool-role results precede image-bearing user messages;
- deterministic call/image order;
- error and abort paths do not leak partial image messages;
- no image result means no synthetic user message.

#### Unit B: conversation-store

**Owns:** `packages/conversation-store/`

Job:

- Persist optional parent conversation ID and conversation tool policy.
- Export typed public behavior for set/get/query.
- Resolve legacy missing policy to `all`.
- Support direct-child/descendant queries without mutating append-only history.
- Clean metadata through normal conversation deletion lifecycle.

Required tests:

- all policy variants round-trip and survive store reopen;
- legacy default;
- parent round-trip;
- direct children and descendants;
- no cycles through the public write-on-create path;
- deletion cleanup;
- malformed persisted policy degrades according to the documented safe rule.

Units A and B are disjoint and run in parallel.

### Wave 2 — session-orchestrator assembly

#### Unit C: session-orchestrator

**Owns:** `packages/session-orchestrator/`

Job:

- Accept initial parent ID and tool policy for a new conversation.
- Persist them without pre-creating metadata before new-conversation workspace setup.
- Add the resolved `modelName` to `ToolAssembly`.
- Apply persisted tool policy after the tools filter chain.
- Expose/retain typed operations agent management needs: start/enqueue, subscribe, status,
  and open signal through existing services rather than implementation reach-through.
- Compact tool-generated image data before incremental persistence via the injected vision service.

Required tests:

- policy `none` yields `tools: []` on every turn;
- a filter cannot re-add tools after final policy enforcement;
- allow/deny behavior;
- policy survives follow-up turns;
- initial lineage/policy does not skip workspace assignment, title, or first system prompt;
- model name reaches filters;
- tool images are stored as compact URLs, not base64;
- ordinary conversations are unchanged.

### Wave 3 — agent-management extension

#### Unit D: agent-management

**Owns:** new `packages/agent-management/`

Job:

- Export the typed service handle and contract.
- Implement pure validation/default/access/formatting decisions plus injected shell effects.
- Contribute all seven tools:
  `list_agent_models`, `summon_agent`, `list_agents`, `read_agent`, `send_agent_message`,
  `cancel_agent_message`, and `open_agent`.
- Resolve caller workspace/working directory/computer through injected stores.
- Enforce lineage-based target access and scoped short-ID resolution.
- Read and compose text files with local/remote containment.
- Implement event-driven waiting, cancellation, timeout, unsubscribe, and result limits.
- Use existing orchestrator/message-queue/open behavior instead of duplicating it.

Required tests, grouped by public operation:

- **models:** exact selectable names; query/vision/limit filters; metadata fallback; no credential
  secrets; catalog failure.
- **summon:** inheritance; explicit existing-workspace override; unknown workspace/model; file
  composition; non-blocking/waiting/open; lineage and policy persisted; cancellation does not kill
  child; output truncation.
- **list:** children/descendants/workspace; status/query/limit; no unauthorized metadata leak;
  stable result shape.
- **read:** full and short IDs; ambiguity; unauthorized target; no reasoning; wait/timeout/abort.
- **send:** idle starts a turn, active queues; files; waiting; existing policy and
  workspace remain authoritative.
- **cancel message:** queued, already delivered, unknown, unauthorized, and idempotent cancellation.
- **open:** emits typed hook with persisted workspace.
- **shell:** logs via injected logger; no prompt/file contents in attributes; all subscriptions and
  resources cleaned up.

### Wave 4 — vision integration

#### Unit E: vision-handoff

**Owns:** `packages/vision-handoff/`

Job:

- Consume `AgentManagementService` through its exported typed handle.
- Replace private conversation-summon/wait logic with the service.
- Start vision consultation with inherited context and durable `toolPolicy: none`.
- Register the model-aware tools filter.
- Hide `consult_vision` from vision models and `read_image` from non-vision models.
- Add `read_image` with local/remote containment, MIME/type/count/size validation, and existing
  temporary-image lifecycle integration.
- Update consultation result text to point to management tools for follow-up rather than requiring
  the CLI, while retaining CLI fallback documentation in the skill.

Required tests:

- authoritative `ModelInfo.vision` and heuristic fallback;
- complementary tool visibility;
- final `none` policy wins;
- consultation same-workspace/working-directory/computer inheritance;
- provider receives empty tools on first and later turns, including store reopen;
- parent receives text only;
- read one/multiple images; unsupported/missing/oversized/traversal cases; remote backend;
- compact URL persistence/resolution and cleanup;
- no recursive `consult_vision` availability to the vision agent.

### Wave 5 — composition and dependent test fan-out

#### Unit F: host-bin

**Owns:** `packages/host-bin/`

Job:

- Activate `agent-management` in topological order.
- Wire its typed dependencies.
- Ensure `vision-handoff` can resolve the service without raw string coupling.
- Verify startup when optional services degrade or are unavailable according to contract.

#### Affected-owner fan-out

Run `lsp references` after contract changes. Summon the owners of any packages whose compile-time
surfaces/tests need updates. Do not let the agent-management or vision owner edit those packages.

### Wave 6 — harness and documentation

**Owner:** orchestrator for allowed docs/config; package owner for extension-scoped docs if located
inside its package.

- Add confirmed glossary entries and aliases to avoid.
- Update the `dispatch-cli` skill into an agent-management guidance skill or create a new
  `agent-management` skill, subject to the skill boundary decision.
- Teach agents to prefer native management tools and retain CLI fallback/recovery commands.
- Update root workspace `AGENTS.md` non-blocking and autonomous patterns to use the new tools where
  available, while preserving CLI commands for humans and failure recovery.
- Update `README.md` package table and tool list.
- Update the vision handoff documentation: tool-free consultation and native image reading.
- Record only non-inferable inheritance, access, waiting, and restriction guarantees.

---

## 18. Verification protocol

After every wave, the orchestrator reads reports and public surfaces, runs diagnostics, checks file
ownership, and commits only a green milestone.

Required authoritative commands:

```sh
bun run typecheck
bun run test
bun run test:bun
bun run check
git status --short
```

No feature work is trusted from an agent's report alone.

### End-to-end acceptance scenarios

1. A parent in workspace `dispatch` calls `summon_agent` without context overrides. The child is in
   `dispatch`, inherits the effective working directory/computer, opens in the frontend, and
   immediately returns its conversation ID.
2. `summon_agent(wait: true)` waits without polling and returns only final assistant text. Stopping
   the parent cancels the wait but leaves the child running.
3. `list_agent_models` returns exact summonable model names and vision metadata without exposing
   credential secrets.
4. `list_agents`, `read_agent`, `send_agent_message`, `cancel_agent_message`, and `open_agent`
   operate on authorized descendants with both full and unambiguous short IDs.
5. An unauthorized sibling conversation cannot be read or mutated through the tools.
6. `send_agent_message` starts a new turn when the target is idle and queues when active.
7. The existing CLI continues to pass its current command tests and live smoke tests unchanged.
8. A non-vision model with a pasted screenshot sees `consult_vision` but not `read_image`.
9. A vision-capable model never sees `consult_vision`; it can discover a PNG path, call
   `read_image`, receive the native image on its next step, and answer from it.
10. A consultation conversation receives `tools: []` on its first turn, follow-up turns, and after
    a backend restart. It can only return text to the parent.
11. No base64 image is persisted in SQLite or emitted in ordinary tool-result telemetry.
12. All typecheck, Vitest, Bun/SQLite, and Biome checks are green with no out-of-owner edits.

---

## 19. Cross-repo dependencies

Most of this feature is self-contained in the backend repo. The following changes cross repo
boundaries and need separate awareness or coordination:

- **`ConversationMeta` wire type change → frontend repo.** Adding `parentConversationId` and
  `toolPolicy` as optional fields to the wire type (defined in `packages/wire/` in the backend)
  affects the API responses the frontend receives. For V1 the frontend likely needs no code
  changes — it can ignore optional fields it does not render — but the contract change should be
  flagged so the frontend team is aware.

- **`ToolContract` kernel change → all provider adapters.** If `loading` and `namespace` fields
  are added to `ToolContract` in the future (deferred tool loading), both `packages/openai-stream/`
  (backend) and `claude/packages/provider-anthropic/` (claude repo) convert `ToolContract` objects
  and would need to handle the new fields. This is not needed for the first version since deferred
  tool loading is not being implemented yet.

- **Anthropic deferred tool loading → claude repo.** If deferred tool loading is implemented for
  Anthropic in the future, the changes live in `claude/packages/provider-anthropic/src/convert.ts`
  and `stream.ts` — adding `defer_loading` to tool serialization, handling the `tool_search` server
  tool, and processing `tool_reference` blocks. This is external to the backend repo and needs
  separate coordination. Not needed for the first version.

---

## 20. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tool restrictions rely only on prompting | Durable conversation tool policy applied last in assembly; provider receives an empty tool list. |
| AI tool becomes an unrestricted server-wide admin surface | Lineage-based access, workspace-scoped listing, authorized short-ID resolution, self-target rejection. |
| Parent blocks indefinitely on a child | Non-blocking defaults, event-driven bounded wait, cancellation cleanup, child independence. |
| Duplicate orchestration logic diverges from CLI/backend behavior | Typed service delegates to existing orchestrator/queue/open contracts; no CLI subprocess. |
| Workspace defaults depend on frontend/global state | Resolve persisted caller workspace through injected conversation-store service. |
| A tool filter reintroduces tools to a restricted conversation | Persisted policy is applied after the entire filter chain. |
| Vision model receives recursive vision tool | Model-aware filter removes `consult_vision`; consultations additionally use policy `none`. |
| Tool-loaded image breaks provider message ordering | Kernel appends complete tool-result batch before synthetic image-bearing user messages. |
| SQLite/logs receive large base64 images | Session shell compacts before persistence; events omit image data. |
| Agent owners overlap | Dependency waves and one package owner per unit; orchestrator owns contracts/config/harness only. |
| New feature grows into a workflow engine | Explicit exclusions in §6.8; add only after concrete evidence under P4. |

---

## 21. User decision checklist

The plan recommends the bold choices below, but implementation must not begin until the human-gated
boundary/vocabulary decisions are confirmed.

1. Vocabulary:
   - **`subagent`** for a conversation created by an agent;
   - **agent management** for the feature;
   - **`agent-management`** for the extension;
   - the seven tool names in §6.

2. Extension boundary:
   - **new standard `agent-management` extension**;
   - alternative: expand `session-orchestrator` (not recommended).

3. Vision image tool boundary:
   - **`read_image` inside `vision-handoff`**;
   - alternative: separate `tool-read-image` extension.

4. Summon defaults:
   - **`wait: false`, `open: true`, model required**;
   - inherit workspace, working directory, and computer;
   - AI workspace override must reference an existing workspace.

5. Access:
   - **mutations limited to descendants; workspace-wide concise listing allowed**;
   - alternative: all conversations in the caller workspace are manageable.

6. Tool control:
   - **public summon schema exposes only `toolAccess: all | none`** while persistence supports
     allow/deny;
   - alternative: expose arbitrary allow/deny tool-name lists now.

7. Vision “text only”:
   - **empty tools and only final text returned to the parent**;
   - decide separately whether reasoning should also be hidden in the consultation's own UI.

8. Skill boundary:
   - **create an `agent-management` skill and keep `dispatch-cli` as fallback/recovery**;
   - alternative: expand the existing `dispatch-cli` skill into both topics.

---

## 22. Recommended implementation stopping point

The milestone is complete when the seven management tools, durable policy/lineage, vision tool
isolation, and native `read_image` path all pass the acceptance scenarios. Stop there. Do not add a
workflow language, recursive lifecycle manager, automatic continuation agent, budgets, voting,
scheduled agents, or frontend lineage UI in the same feature. Those are separate capabilities that
must earn their own boundaries under P4.
