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
- [x] **host** — discovery→DAG→activate→registries; builds HostAPI (wraps bus). `dbcf219` (50 tests)

### Core extensions (each ships a real manifest, loaded via the host)
- [x] **storage-sqlite** — bun:sqlite StorageNamespace + migrations (21 bun tests). `9b611d6`
- [x] **auth-apikey** — pure resolver env → ApiKeyCredentials (4 tests). `9b611d6`
- [x] **provider-openai-compat** — OpenAI-compatible SSE → ProviderEvents. `9b611d6`
- [x] **conversation-store** — append-only persistence + pure reconcile (16 tests). `8b9cc0c`
- [~] **session-orchestrator** — load history → resolve provider/tools → runTurn → persist. RUNNING (parallel).
- [~] **transport-http** — Hono `/chat` NDJSON stream; calls orchestrator seam. RUNNING (parallel).

### Integration
- [ ] **host-bin** — boot: load config (.env → config), discover+activate
      extensions, start transport.
- [ ] **curl smoke test** — `curl -d '{...}' /chat` → real response from flash;
      verify multi-turn.

## Verified state (this session)
- Full `bun run typecheck` clean; `bun run test` 66 pass (vitest);
  `bun run test:bun` 21 pass (storage); `bun run check` clean.
- Root `tsconfig.json` references all 4 packages. `vitest.config.ts` excludes
  storage-sqlite (bun:sqlite) → `test:bun`.

## Resolved decisions
- **Import path:** everything imports from `@dispatch/kernel` root barrel (NOT a
  `/contracts` subpath). Standardized; provider was fixed to match.
- **Test runner split:** Bun-runtime packages (bun:sqlite) test via `bun test`;
  the rest via vitest. `test:all` runs both.

## Open contract-watch (decide at composition)
- **Provider credentials path:** provider currently reads creds from
  `host.config.get("provider.openai-compat.*")` and does NOT use the
  `AuthContract` from auth-apikey. For full fidelity the **session-orchestrator/
  host-bin** should resolve `AuthContract.resolve()` → feed the provider, OR we
  keep config-driven and auth-apikey stays vestigial for MVP. PREFER: orchestrator
  wires auth→provider. Decide when building host-bin.
- **host dependency-injection shape:** what host-bin must wire (storageFactory,
  logger, config, secrets, perms). Defined by the host agent — review on return.

## Build order (remaining)
host → conversation-store → session-orchestrator → transport-http → host-bin → curl.

## Parallelization notes
- host + conversation-store CAN run in parallel (disjoint files; conversation-store
  builds against the StorageNamespace contract, not the host impl).
- session-orchestrator + transport-http + host-bin are more sequential (compose
  the others) — do after host lands.
