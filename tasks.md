# MVP Tasks — kernel + core extensions → working `curl` turn

Goal: send a message via HTTP `curl` and get a real multi-turn response from
OpenCode Go (flash), through the **actual architecture** (full fidelity: every
core feature is an extension loaded via manifest through the host).

Contracts are referenced **statically as types** (so `tsc` + `lsp references`
drive fan-out); extension **loading is dynamic** (manifests via the host).

## Legend: [ ] todo  [~] in progress  [x] done (verified + committed)

### Kernel
- [x] **contracts** — the ABI. `fd855ff` (+ `974ce6f` RunTurnInput tabId/turnId/providerOpts, FinishReason)
- [x] **bus** — event/hook/service bus. `669c269`
- [x] **runtime** — `runTurn` turn loop (dispatch policy §3.3), 16 tests. `ae22da5`
- [~] **host** — discovery→DAG→activate→registries; builds HostAPI (wraps bus). RUNNING.

### Core extensions (each ships a real manifest, loaded via the host)
- [~] **storage-sqlite** — concrete backend behind host.storage (bun:sqlite). RUNNING.
- [~] **auth-apikey** — resolves `{ apiKey, baseURL }` from env (.env). RUNNING.
- [~] **provider-openai-compat** — OpenAI-compatible streaming → ProviderEvents (OpenCode Go flash). RUNNING.
- [ ] **conversation-store** — append-only turn/chunk persistence on host.storage (multi-turn = target B). (after storage-sqlite)
- [ ] **session-orchestrator** — on message: load history → resolve provider/tools → runTurn → persist.
- [ ] **transport-http** — Hono `/chat` route; composes via host/bus.

### Integration
- [ ] **host-bin** — boot: load config, discover+activate extensions, start transport.
- [ ] **curl smoke test** — `curl -d '{...}' /chat` → real response from flash; verify multi-turn.

## Parallel batch in flight
host + storage-sqlite + auth-apikey + provider-openai-compat (disjoint files).
Shared resource: root `tsconfig.json` references — agents NOTE only; orchestrator
adds the 3 package refs after they land (avoids write race).

## Open contract-watch
- Provider credentials/model: how provider receives creds (construction vs stream
  opts). auth-apikey + provider agents building in parallel — RECONCILE on return.
- `host` deps injection shape (storageFactory, logger, config, secrets, perms) —
  defines what host-bin must wire.

## Build order
contracts → bus → runtime → host → storage-sqlite → conversation-store →
auth-apikey → provider-openai-compat → session-orchestrator → transport-http →
host-bin → curl.
