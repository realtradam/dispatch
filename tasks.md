# MVP Tasks — kernel + core extensions → working `curl` turn

Goal: send a message via HTTP `curl` and get a real multi-turn response from
OpenCode Go (flash), through the **actual architecture** (full fidelity: every
core feature is an extension loaded via manifest through the host).

Contracts are referenced **statically as types** (so `tsc` + `lsp references`
drive fan-out); extension **loading is dynamic** (manifests via the host).

## Legend: [ ] todo  [~] in progress  [x] done (verified + committed)

### Kernel
- [x] **contracts** — the ABI (conversation, tool, provider, auth, dispatch, hooks, extension/HostAPI, runtime, events). `fd855ff`
- [x] **bus** — event/hook/service bus (pure dispatch + stateful shell). `669c269`
- [ ] **runtime** — `runTurn` turn loop (provider+tools→events; dispatch policy §3.3). prompt ready: `prompts/kernel-runtime.md`
- [ ] **host** — extension discovery → DAG resolve → activate → registries; builds `HostAPI` (wraps bus). Registries: tools, providers, auth, services, storage, migrations.

### Core extensions (each ships a real manifest, loaded via the host)
- [ ] **storage-sqlite** — concrete backend behind `host.storage` (bun:sqlite).
- [ ] **conversation-store** — append-only turn/chunk persistence on host.storage (multi-turn = target B).
- [ ] **auth-apikey** — resolves `{ apiKey, baseURL }` from `.env`.
- [ ] **provider-openai-compat** — OpenAI-compatible streaming → ProviderEvents (OpenCode Go).
- [ ] **session-orchestrator** — on message: load history → resolve provider/tools → `runTurn` → persist.
- [ ] **transport-http** — Hono `/chat` route; composes the above via host/bus.

### Integration
- [ ] **host-bin** — boot: load config, discover+activate extensions, start transport.
- [ ] **curl smoke test** — `curl -d '{...}' /chat` → real response from flash; verify multi-turn (turn 2 sees turn 1).

## Notes / open contract-watch
- Provider needs resolved credentials/model: `ProviderContract.stream` currently
  has no creds param. Watch when building provider/auth — may be a contract change
  (provider closes over creds at construction, OR add to stream opts).
- `HostAPI.addFilter` lacks optional `{ priority }` (bus supports it). Decide if
  HostAPI should expose it (CR from bus report).

## Build order (dependency-topological)
contracts → bus → runtime → host → storage-sqlite → conversation-store →
auth-apikey → provider-openai-compat → session-orchestrator → transport-http →
host-bin → curl.
