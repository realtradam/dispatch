# Account usage (Claude + Codex) — API contract & frontend handoff

Branch: `feature/account-usage` (backend + frontend worktrees). The frontend view has **already
been implemented** in the same branch (`frontend/src/features/account-usage`, sidebar view id
`account-usage`, label "Usage"). This note covers the contract for any other client.

## 1. Endpoints

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/usage` | `AccountUsageResponse` | Both providers, fixed order `claude`, `codex`. |
| GET | `/usage/:provider` | `AccountUsageReport` | `provider ∈ claude \| codex`; other → 404. |

- `?refresh=1` (or `true`) asks the server to bypass the success TTL. It **cannot** bypass a
  failure cooldown and is ignored when the last attempt was < 30 s ago.
- No client auth (same as every other Dispatch route). The backend uses the `claude-oauth` /
  `codex-oauth` auth providers (from the external `claude/` and `codex/` extensions) — **no tokens
  are ever returned**.
- 503 `{ error }` when the `account-usage` extension isn't loaded. 500 on unexpected failure.

## 2. Types (`@dispatch/transport-contract@0.25.0`)

See `packages/transport-contract/src/index.ts` — `AccountUsageResponse`, `AccountUsageReport`,
`AccountUsageLimit`, `AccountUsageCredits`, `AccountUsageState`, `AccountUsageLimitStatus`,
`AccountUsageProviderId`.

Example (live, trimmed):
```json
{
  "servedAt": 1760450000000,
  "providers": [
    {
      "provider": "claude", "label": "Claude", "state": "fresh",
      "account": { "accountId": "…", "email": "…", "planType": null },
      "limits": [
        { "id": "claude:5h", "label": "5 Hour", "kind": "window", "windowId": "5h",
          "shared": true, "tier": null, "durationMs": 18000000, "resetsAt": 1760464800381,
          "unit": "percent", "used": 28, "limit": 100, "remaining": 72,
          "usedFraction": 0.28, "remainingFraction": 0.72, "status": "ok" },
        { "id": "claude:7d", "label": "7 Day", "...": "..." }
      ],
      "limitReached": null, "canServe": null, "creditOverage": false, "credits": null,
      "fetchedAt": 1760450000000, "lastAttemptAt": 1760450000000,
      "nextRefreshAt": 1760450300000, "error": null
    },
    {
      "provider": "codex", "label": "Codex", "state": "fresh",
      "account": { "accountId": "…", "email": "…", "planType": "pro" },
      "limits": [
        { "id": "codex:primary", "label": "7 days", "windowId": "7d", "durationMs": 604800000,
          "resetsAt": 1760936897000, "used": 25, "...": "..." }
      ],
      "limitReached": false, "canServe": true, "creditOverage": false,
      "credits": { "hasCredits": false, "unlimited": false, "overageLimitReached": false,
                   "balance": 0, "spendControlReached": false },
      "...": "..."
    }
  ]
}
```

Limit ids: `claude:5h`, `claude:7d`, `claude:7d:<model-slug>` (legacy opus/sonnet or generic
`weekly_scoped`), `claude:extra` (spend, USD); `codex:primary`, `codex:secondary`,
`codex:<meter>:primary|secondary` (e.g. `spark`). Codex labels/durations come from
`limit_window_seconds` — don't assume 5h/7d.

## 3. Credential support
- Claude: OAuth bearer from `~/.claude/.credentials.json` (via `claude-oauth`), or an
  API-key-shaped `sk-ant-oat…` OAuth token. Plain Anthropic API keys → `unsupported`.
- Codex: ChatGPT OAuth bearer from `~/.codex/auth.json` (via `codex-oauth`); account id from the
  JWT (`chatgpt-account-id` header). Anything else → `unsupported`.
- Auth provider absent / no credentials → `not-configured`.

## 4. Backend cache / retry
- Success TTL 5 min ±25 % jitter (`nextRefreshAt`). Requests inside the TTL are served from cache.
- Concurrent requests share one in-flight fetch.
- Failure cooldown: Codex 10 s ±25 %, Claude 60 s ±25 %. `not-configured`/`unsupported` recheck
  every 30 s (local only).
- Claude fetch: ≤ 3 attempts, 500 ms × 2^n backoff honoring `Retry-After`; no in-band retry for
  429, aborts/timeouts, or endpoint-absent statuses (404/405/410/501). Custom base URLs fall back
  to `api.anthropic.com` only when the endpoint is absent. Profile (`/api/oauth/profile`) fetched
  when the usage body lacks identity.
- Codex fetch: single attempt (OMP behaviour); only chatgpt.com / chat.openai.com account bases are
  honored, otherwise canonical `https://chatgpt.com/backend-api`.
- Last good report retained 24 h per **account id** (stable across token rotation; a different
  account never inherits another's numbers).

## 5. Polling guidance
Poll `GET /usage` every ~60 s while visible (cheap: cache hit). Use `?refresh=1` only for an
explicit user "Refresh". Use `servedAt` + `resetsAt`/`durationMs` to compute window progress;
re-render the clock locally between polls.

## 6. States
| state | data | meaning |
|---|---|---|
| `fresh` | limits present | last refresh succeeded |
| `stale` | last-good limits; `error` set | latest refresh failed; `fetchedAt` shows data age |
| `unavailable` | none | failed and no last-good (≤ 24 h) for this account |
| `unsupported` | none | credential can't query subscription usage |
| `not-configured` | none | no credential / auth extension not loaded |

`limitReached` = plan allowance consumed (Codex); `canServe` = account can still serve requests
(credits may fund overage — `creditOverage: true`, window status downgraded exhausted→warning).
Additional Codex meters (Spark) are independent of plan credits. `status`: `ok` < 90 % ≤
`warning` < 100 % ≤ `exhausted`; `unknown` for uncapped spend.

## 7. Inference-header ingestion (wired)
- Kernel contract: `providerResponseHeaders` event hook (`kernel/provider.response-headers`,
  payload `{ providerId, authId?, status, headers }`), exported from `@dispatch/kernel`.
- `claude/` `provider-anthropic` emits it (authId `claude-oauth`) with only the
  `anthropic-ratelimit-*` headers; `codex/` `provider-openai` emits it (authId `codex-oauth`) with
  an allow-list of `x-codex-{primary,secondary,credits}-*`, `x-codex-plan-type`,
  `x-codex-active-limit` (the opaque `x-codex-turn-state` is never forwarded). Emission happens on
  every final HTTP response (success or error) and can never break the stream.
- `account-usage` subscribes and calls `ingestHeaders`: throttled to 1/min unless a window is
  exhausted; merges rows by id (endpoint-only rows like spend/scoped meters are kept); never
  advances `fetchedAt`/`nextRefreshAt`; usage never moves backwards within the same window
  instance (headers are coarser, e.g. `0.1` vs endpoint `11%`), only on a reset. A Codex 100%
  window on a 2xx response is `warning` (the account is demonstrably serving).
- Zero-length windows (`limit_window_seconds: 0` / `window-minutes: 0`) are Codex's "no such
  window" placeholder and are dropped.
- Header ingestion only refines an existing report; with no report yet, the next poll fills it.

## 8. Verification
- Backend: `bun run typecheck` ✓, `bun run check` ✓, `bun run test` ✓ (174 files / 3149 tests;
  36 new), `bun test packages/host-bin/src/bundled.bun.test.ts` ✓,
  `bun packages/plugin-verify/src/cli.ts packages/account-usage` ✓.
- Live probe against real accounts: Claude (5h + 7d windows) and Codex Pro (7-day window) both
  `fresh`.
- End-to-end live probe: real kernel host + real auth/provider extensions from `claude/` and
  `codex/` + account-usage → one inference per provider emitted the event (12 Claude / 13 Codex
  headers) and the cached reports stayed consistent.
- claude: typecheck/check ✓, 89 tests; codex: typecheck/check ✓, 127 tests.
- **Merge order:** merge the backend (kernel `providerResponseHeaders`) and rebuild its dist
  (`bun run typecheck`) BEFORE merging the claude/codex branches — they value-import the hook
  from `../backend/packages/kernel/dist`.
- Known limitations: reset-credit redemption intentionally not implemented; mimicry constants
  (Claude betas/CLI version, Codex UA) are version-locked copies.
