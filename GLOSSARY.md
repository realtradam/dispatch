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
| **tool call** | A model's request to run a tool within a step. | function call (when meaning a tool call) |
| **chunk** | One ordered piece of a message (text, thinking, tool-call/result, etc.), append-only in the log. | block, segment |
| **seq** | The monotonic, gap-free, per-conversation sequence number stamped on each chunk as it is appended to the log. The sync cursor: a client requests `?sinceSeq=N` to fetch only newer chunks. Storage/sync metadata, never message content. | cursor (when meaning the number), offset, index |
| **StoredChunk** | The wire envelope `{ seq, role, chunk }`: a persisted chunk plus its sync metadata. Keeps the pure `chunk` free of storage concerns while a flat seq-ordered stream stays both syncable and regroupable into messages. | seq'd chunk |
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

## Known vocabulary drift

- _None._ The former `tabId` drift in `AgentEvent`s and `RunTurnInput` was fully
  resolved (renamed to `conversationId` across contracts + every consumer; see
  tasks.md Step 4). `tabId` is retained only in the "Aliases to avoid" column
  above so it is never reintroduced.
