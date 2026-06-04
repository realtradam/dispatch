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
- [~] **kernel-crs** — CR-2 (HostAPI.getProviders/getTools), CR-3 (runTurn use tabId/turnId). RUNNING.

### Core extensions (each ships a real manifest, loaded via the host)
- [x] **storage-sqlite** — bun:sqlite StorageNamespace + migrations (21 bun tests). `9b611d6`
- [x] **auth-apikey** — pure resolver env → ApiKeyCredentials (4 tests). `9b611d6`
- [x] **provider-openai-compat** — OpenAI-compatible SSE → ProviderEvents. `9b611d6`
- [x] **conversation-store** — append-only persistence + pure reconcile (16 tests). `8b9cc0c`
- [x] **session-orchestrator** — load history → resolve provider/tools → runTurn → persist (12 tests). `357ad35`
- [x] **transport-http** — Hono `/chat` NDJSON stream; calls orchestrator seam (20 tests). `357ad35`

### Integration
- [ ] **host-bin** — boot: load config (.env → config), discover+activate
      extensions (storage→conversation-store→provider/auth→orchestrator→transport),
      wire auth→provider, start `Bun.serve`.
- [ ] **curl smoke test** — `curl -d '{...}' /chat` → real response from flash;
      verify multi-turn (2nd message sees 1st).

## Verified state (this session)
- Full `bun run typecheck` clean across all 7 packages.
- `bun run test` → 164 vitest tests pass. `bun run check` clean.
- Root `tsconfig.json` now references all 7 packages.

## Open contract-watch (decide at host-bin composition)
- **Provider credentials path:** provider reads creds from `host.config`
  (`provider.openai-compat.*`) and does NOT yet use `AuthContract` from
  auth-apikey. PREFER: host-bin/orchestrator resolves `AuthContract.resolve()`
  → feeds provider. Decide when building host-bin. (auth-apikey otherwise
  vestigial for MVP.)

## Build order (remaining)
kernel-crs → host-bin → curl.

## Parallelization log
- host + conversation-store ran in parallel (disjoint). ✓
- session-orchestrator + transport-http ran in parallel (disjoint). ✓
- kernel-crs is solo (touches shared contracts/extension.ts).
