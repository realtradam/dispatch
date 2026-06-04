# MVP Tasks — kernel + core extensions → working `curl` turn

Goal: send a message via HTTP `curl` and get a real multi-turn response from
OpenCode Go (flash), through the **actual architecture** (full fidelity: every
core feature is an extension loaded via manifest through the host).

Contracts are referenced **statically as types** (so `tsc` + `lsp references`
drive fan-out); extension **loading is dynamic** (manifests via the host).

## Legend: [ ] todo  [~] in progress  [x] done (verified + committed)

### Kernel
- [x] **contracts** — the ABI. `fd855ff` (+ `974ce6f`)
- [x] **bus** — event/hook/service bus. `669c269`
- [x] **runtime** — `runTurn` turn loop (dispatch §3.3), 16 tests. `ae22da5`
- [x] **host** — discovery→DAG→activate→registries; builds HostAPI (wraps bus). `dbcf219`
- [x] **kernel-crs** — CR-2 (HostAPI.getProviders/getTools), CR-3 (runTurn tabId/turnId). `e56b591`

### Core extensions (each ships a real manifest, loaded via the host)
- [x] **storage-sqlite** — bun:sqlite StorageNamespace + migrations. `9b611d6`
- [x] **auth-apikey** — pure resolver env → ApiKeyCredentials. `9b611d6`
- [x] **provider-openai-compat** — OpenAI-compatible SSE → ProviderEvents. `9b611d6`
- [x] **conversation-store** — append-only persistence + pure reconcile. `8b9cc0c`
- [x] **session-orchestrator** — load history → resolve provider/tools → runTurn → persist. `357ad35`
- [x] **transport-http** — Hono `/chat` NDJSON stream. `357ad35`

### Integration
- [x] **host-bin** — boot: config (.env), discover+activate extensions, Bun.serve. `bf52b11`
- [x] **curl smoke test** — ✅ VERIFIED LIVE against OpenCode Go flash (opencode-1 key).

## ✅ MVP ACHIEVED (verified live)
- Single turn: `curl -d '{"message":"Say hello in exactly 3 words."}'` → `"Hello my friend"`.
- **Multi-turn:** `conversationId` threads history — turn 1 "remember PINEAPPLE" →
  turn 2 "what was the secret word?" → `"PINEAPPLE"`. ✓ (target B, §2.8)
- Full path: curl → transport-http → session-orchestrator → host/registry →
  provider-openai-compat → OpenCode Go flash → ProviderEvents → AgentEvents → NDJSON.
- 178 vitest tests pass; `tsc -b` clean; biome clean.

### API note (for callers)
- Chat request field is **`conversationId`** (not `tabId`) to thread multi-turn.
  Omit it → a fresh conversation (random id) each call.

## Open items (post-MVP, not blocking)
- **auth-apikey is vestigial:** provider reads creds from `host.config`, does NOT
  yet use `AuthContract.resolve()`. Wire auth→provider properly (see host-bin CR).
- **host CR-1:** `createHost` should expose `getHostAPI()` so host-bin drops its
  adapter duplication.
- **storage-sqlite CR-2:** manifest declares `contributes.services:["storage"]`
  but activate is a no-op (backend is a kernel dep). Reconcile manifest vs reality.
- **Stale detached server** on port 18390 from an earlier run — harmless, ignore/kill.
- Tools path unexercised by MVP (turn completes with `tools: []`). Add a tool ext next.

## Parallelization log
- host + conversation-store ran in parallel (disjoint). ✓
- session-orchestrator + transport-http ran in parallel (disjoint). ✓
- kernel-crs solo (touched shared contracts/extension.ts).
