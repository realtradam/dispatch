# Frontend handoff — LSP status + per-conversation CWD

> Backend milestone complete (this repo). The web frontend is a SEPARATE repo
> (`../dispatch-web`); this document is couriered to it by the user (ORCHESTRATOR
> §7 — `lsp references` does not span repos). All types below are exported from
> `@dispatch/transport-contract` (bumped to **0.5.0**).

## TL;DR for the FE
Two new capabilities are now on the backend:
1. **Per-conversation working directory (cwd)** — get/set per tab (a tab = a
   `conversationId`). Persisted server-side; defaults a turn's cwd when `/chat`
   omits one.
2. **Per-conversation LSP status** — which language servers are configured for a
   tab's cwd and whether each is connected.

## Endpoints

### `GET /conversations/:id/cwd` → `CwdResponse`
```ts
interface CwdResponse { conversationId: string; cwd: string | null }
```
`cwd` is `null` until set.

### `PUT /conversations/:id/cwd` (body `SetCwdRequest`) → `CwdResponse`
```ts
interface SetCwdRequest { cwd: string }
```
- `200` with the new `CwdResponse` on success.
- `400` `{ error }` if `cwd` is missing/empty.
- Content-Type `application/json`. CORS now allows `PUT`.

### `GET /conversations/:id/lsp` → `LspStatusResponse`
```ts
type LspServerState = "connected" | "starting" | "error" | "not-started";
interface LspServerInfo {
  id: string;            // "typescript", "luau-lsp"
  name: string;          // display name
  root: string;          // absolute workspace root the server is rooted at
  extensions: string[];  // e.g. [".ts",".tsx"] or [".luau"]
  state: LspServerState;
  error?: string;        // present only when state === "error"
}
interface LspStatusResponse {
  conversationId: string;
  cwd: string | null;          // the tab's persisted cwd
  servers: LspServerInfo[];    // [] when cwd is null
}
```

## Behavior notes (important for UX)
- **`GET /conversations/:id/lsp` lazily connects.** The first call for a cwd
  resolves the configured servers and **spawns + initializes** them, so it can take
  a moment (typically <1s; a cold luau-lsp loading Roblox types can take longer) and
  returns once each server reaches `connected`/`error`. Subsequent calls are fast
  (cached). Suggested UX: call it when a tab opens / cwd changes, show a spinner per
  server until `state` settles, then a connected/error badge.
- **`servers` is empty when `cwd` is null** — prompt the user to set a cwd first.
- **States:** `connected` = ready; `error` = failed to start (`error` has the
  reason, e.g. binary not found); `not-started`/`starting` = transient.
- **cwd defaulting:** if a `/chat` (or `/chat/warm`) request omits `cwd`, the
  backend now uses the conversation's persisted cwd. If a request DOES send `cwd`,
  that value is used AND persisted (so the CLI `--cwd` keeps the stored value
  fresh). The FE's PUT and the chat `cwd` field write the same per-conversation
  store.

## How servers are configured (so you can explain it to users)
Per the tab's cwd, the backend resolves language servers from, in order:
1. `<cwd>/.dispatch/lsp.json` (`{ servers: { <id>: { command, extensions,
   rootMarkers?, env?, initialization?, watch? } } }`)
2. fallback `<cwd>/opencode.json` `lsp` key (opencode-compatible)
3. a built-in `typescript` server (so a TS project works with zero config).
No FE work needed for this — just display `LspStatusResponse`.

## Operational note (surface to users on `state:"error"`)
Language-server binaries must be on the **backend process's PATH**. A binary in a
non-standard location (e.g. `~/.local/bin/typescript-language-server`) won't be
found if the server daemon's PATH lacks that dir, yielding
`state:"error", error:"ENOENT ... posix_spawn '<bin>'"`. luau-lsp
(`/usr/local/bin`) and standard-PATH binaries work out of the box. Consider showing
the `error` text directly so users can diagnose a missing/unfound binary.

## Verified live
- Roblox project (`luau-lsp`) → `connected` through the full HTTP path
  (`GET /conversations/:id/lsp`), using the project's existing `opencode.json` +
  an auto-spawned `rojo sourcemap --watch` sidecar.
- This repo (`typescript`) → `connected`.
- cwd PUT/GET round-trip → `200` + correct value.

## Not in this slice (potential future FE asks)
- A live WS surface for LSP status (currently HTTP-poll on tab open / cwd change).
- An LSP-diagnostics stream pushed into the chat (the agent can pull diagnostics
  via the `lsp` tool today; auto-inject-on-write was deliberately deferred).

---

## CONFIRMED — answers to `backend-handoff-cwd-lsp.md` (your 6 asks)

> Re your courier doc. All six hold in the current backend. Code refs are
> `packages/transport-http/src/app.ts` and `packages/session-orchestrator/src/
> orchestrator.ts`. None require a backend change. **The draft → first-message cwd
> path you built is fully supported.**

| # | Your ask | Confirmed | Where |
|---|----------|-----------|-------|
| 1 | Unseen id: `GET /cwd` ⇒ `200 {cwd:null}`; `GET /lsp` ⇒ `200 {cwd:null,servers:[]}` (no 404/500) | ✅ | `getCwd` returns `null` for any id; `/lsp` early-returns `{cwd:null,servers:[]}` before touching the LSP — `app.ts:322-333, 364-372` |
| 2 | `PUT /cwd` on an unseen/draft id persists (no prior turn/row) | ✅ | `setCwd` is a plain per-id upsert (key `conv:<id>:cwd`) — `app.ts:335-362` |
| 3 | Draft cwd carries into turn 1 (`PUT D/cwd`, then `chat.send` D with no `cwd`) | ✅ | orchestrator uses the persisted cwd when the request omits it; same store key the PUT writes — `orchestrator.ts:122-125`. Unit-tested ("uses the persisted cwd when the request omits cwd") |
| 4 | CORS **preflight** (`OPTIONS` + `Access-Control-Request-Method: PUT`) is answered | ✅ | global Hono `cors`, `allowMethods:["GET","POST","PUT","OPTIONS"]` applied to all routes — `app.ts:112-114`; preflight test passes |
| 5 | No spawn when `cwd` is null | ✅ | `/lsp` returns `servers:[]` before calling the LSP service when `cwd===null` — `app.ts:367-372` |
| 6 | Error body is `{ error: string }` | ✅ | every error path returns `{error}` (e.g. empty-cwd PUT ⇒ `400 {error:"Field 'cwd' is required and must be a non-empty string"}`) — `app.ts:342,346,350,360,376,400` |

### Setting the cwd on the first message — two supported flows
- **(a) Pre-set, then send (your flow):** `PUT /conversations/D/cwd {cwd}` on the
  client-minted draft id → then `POST /chat {conversationId:D}` **without** a `cwd`
  field → the turn loads and runs in the persisted `D` cwd.
- **(b) cwd on the first `/chat`:** include `cwd` in the first `POST /chat` → it is
  used for that turn **and** persisted for subsequent turns.
Both write/read the same per-conversation store, so they're interchangeable; a draft
that has never sent a message works because the cwd store is independent of history.

### One edge to be aware of (FE currently safe)
`PUT /cwd` rejects an empty-string `cwd` (`400`), but the **`/chat` `cwd` field**
does not — the orchestrator treats any non-`undefined` `cwd` as "provided", so a
literal `cwd:""` on `/chat` would override the persisted cwd with empty. Your FE
omits the field (sends `undefined`) on cwd-less sends, so this never triggers. **Keep
omitting the field (don't send `cwd:""` / `cwd:null`)** when you want the persisted
draft cwd to apply. (If preferred, the backend can harden this to treat empty/blank
as "not provided" — say the word.)

### Live-verified
Unseen-id `GET /cwd` ⇒ `{cwd:null}`, `GET /lsp` ⇒ `{cwd:null,servers:[]}`,
`PUT` round-trip `200`, and the empty-cwd `400 {error}` shape were all observed live;
Roblox `luau-lsp` and this repo's `typescript` both reach `state:"connected"`.
