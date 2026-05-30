# Claude Auth Report — "old tab 401s, new tab works"

## Symptom

A tab that has been open for a while starts failing **every** Claude request with:

```
Invalid authentication credentials
status=401  authentication_error
url=https://api.anthropic.com/v1/messages
model=claude-opus-4-8   baseURL=https://api.anthropic.com/v1
```

Opening a **new tab** and selecting the same Claude key works fine. The old tab
keeps 401-ing no matter what you send. Both tabs are configured against the same
`anthropic` key (`claude-pro` / `claude-max`), so "they should be using the same
auth" — but they are not.

This is an **authentication-layer** problem, not an agent/tool-wiring/permission
bug. The 401 comes back from Anthropic on the chat request itself.

---

## Decisive clue: new tab works, old tab doesn't

This single fact rules out most hypotheses and points at exactly one mechanism:
**the per-tab `Agent` instance is cached, and it freezes the access token it was
constructed with.** A new tab builds a fresh `Agent`, re-resolves credentials
from the DB, and gets a currently-valid token. The old tab never re-resolves.

---

## Root cause #1 (proximate, confirmed): the cached per-tab Agent freezes a stale access token

### Where the token is captured

Credentials are resolved **only when a new `Agent` is constructed**, inside
`getOrCreateAgentForTab` in `packages/api/src/agent-manager.ts`:

- The `anthropic` branch (lines ~579–636) resolves `claudeCredentials =
  { accessToken: <token> }` and passes it into the `Agent` constructor
  (lines ~686–700, `...(claudeCredentials ? { claudeCredentials } : {})`).
- That token is stored on the Agent's `this.config.claudeCredentials` and never
  updated for the life of the Agent.

In `packages/core/src/agent/agent.ts`, every `run()` call rebuilds the provider
from that frozen config:

```ts
const providerFactory = createProvider({
    apiKey: this.config.apiKey,
    baseURL: this.config.baseURL,
    provider: this.config.provider,
    claudeCredentials: this.config.claudeCredentials,   // <-- frozen at construction
});
```

And in `packages/core/src/llm/provider.ts`, `createClaudeOAuthProvider` sends it
as the bearer token:

```ts
authToken: config.claudeCredentials?.accessToken ?? config.apiKey,
```

So the access token used on the wire is whatever was captured when the tab's
Agent was first built. Calling `run()` again does **not** refresh it.

### Why the cache is never invalidated on expiry

`getOrCreateAgentForTab` (agent-manager.ts lines ~361–368) only discards the
cached Agent when the key, model, or permissions change:

```ts
if (
    tabAgent.agent &&
    (effectiveKeyId !== tabAgent.keyId ||
        effectiveModelId !== tabAgent.modelId ||
        permKey !== tabAgent._lastPermKey)
) {
    tabAgent.agent = null;
}
```

**Token expiry is not one of the conditions.** A tab that keeps the same key +
model + permissions will reuse the same `Agent` — and therefore the same frozen
token — indefinitely. The credential-refresh code below this gate only runs when
`tabAgent.agent` is null, which for a stable tab never happens again.

### Why this produces the exact symptom

- **Old tab:** built its `Agent` earlier with token **A**. Time passes. Token A
  is no longer accepted by Anthropic (it either reached its ~8h TTL, or a refresh
  elsewhere — a new tab, the Model Status panel, model listing — rotated the
  credential in the DB and **revoked A** server-side). The cached Agent still
  holds A. Cache gate sees no key/model/perm change → Agent reused → every
  request sends the dead token A → `401 authentication_error`.
- **New tab:** no cached Agent → runs the resolution path → reads the **current**
  token from the DB (and/or refreshes) → token **B** → works.

Both tabs "use the same key," but the old tab is pinned to a now-invalid
*instance* of that key's token. That is the whole discrepancy.

> Note on OAuth token rotation: Anthropic's refresh flow rotates the refresh
> token and can invalidate the previously issued access token. So the moment any
> code path successfully refreshes the credential (updating the DB), every
> already-constructed Agent still holding the old access token is now holding a
> *revoked* token — not merely an expired one. This is why the old tab can fail
> even when its captured token's local `expiresAt` hasn't elapsed yet.

---

## Root cause #2 (contributing, confirmed by reference): the OAuth refresh call is malformed

Even when the resolution path *does* run, the refresh half of it is broken, so
the system can't reliably self-heal an expired token.

`packages/core/src/credentials/claude.ts`:

```ts
const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token";   // line 27 — wrong host

async function refreshViaOAuth(refreshToken: string) {
    const body = new URLSearchParams({ grant_type: "refresh_token", client_id: OAUTH_CLIENT_ID, refresh_token: refreshToken });
    const response = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },   // wrong content-type
        body: body.toString(),                                              // form-encoded
    });
    if (!response.ok) return null;   // failure is swallowed silently
    ...
}
```

Two concrete defects, both contradicted by the working reference implementation
in `references/oh-my-pi/packages/ai/src/utils/oauth/anthropic.ts`:

1. **Wrong endpoint host.** The token exchange/refresh endpoint lives on the API
   host, not the web-app host:
   ```ts
   const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";   // reference, line 11
   ```
   The reference's test suite asserts exactly this URL
   (`references/oh-my-pi/packages/ai/test/anthropic-oauth.test.ts`). `claude.ai`
   is correct only for the *authorize* step (`https://claude.ai/oauth/authorize`).

2. **Wrong body format.** Anthropic's `/v1/oauth/token` expects **JSON**, not
   form-encoding. The reference posts:
   ```ts
   headers: { "Content-Type": "application/json", Accept: "application/json" },
   body: JSON.stringify(body),
   ```

Because both are wrong, `refreshViaOAuth` effectively always returns `null`. When
a token has genuinely expired, the manager's `anthropic` branch hits its final
`else` and does the worst possible thing — proceeds with the **stale** token:

```ts
console.warn(`dispatch: unable to refresh Claude credentials for "${account.label}" — using stale token`);
claudeCredentials = { accessToken: account.credentials.accessToken };  // expired
...
useOverride = true;
```

So the contributing failure mode is:
- New tabs work **only as long as the DB token is still valid** (e.g. because
  Claude Code refreshed it on disk and it was re-imported, or it simply hasn't
  expired yet). Dispatch's *own* refresh cannot renew it.
- Once the DB token expires with no external renewal, even new tabs will 401,
  and the warning above appears in the server log.

**Diagnostic check:** look in the server logs for
`dispatch: unable to refresh Claude credentials for "..." — using stale token`.
Its presence confirms the refresh path is failing and the stale-token fallback
fired.

> History: both the wrong URL and the form-encoded body were introduced in the
> original commit `8151447` ("feat: claude max oauth support…"). They have never
> been correct in this repo.

---

## Secondary suspect (unverified): the chat provider omits `anthropic-beta`

`createClaudeOAuthProvider` (provider.ts lines ~76–84) sets only:

```ts
headers: {
    "anthropic-dangerous-direct-browser-access": "true",
    "x-app": "cli",
    "user-agent": "claude-cli/2.1.112 (external, sdk-cli)",
}
```

It does **not** send `anthropic-beta: …,oauth-2025-04-20,…` or
`anthropic-version`. Every other path in this codebase and in the reference does:

- `getAnthropicHeaders()` (claude.ts:387) builds the full set, including
  `oauth-2025-04-20`, and is used by the models/profile/usage calls.
- The reference's chat path always sends `anthropic-beta: ANTHROPIC_OAUTH_BETA`
  with the OAuth bearer (`references/oh-my-pi/.../provider-models/openai-compat.ts`,
  `.../providers/anthropic.ts:1542`). Anthropic generally requires the
  `oauth-2025-04-20` beta for Bearer/OAuth requests.

This is flagged **secondary** because chat works at all on a fresh token, which
suggests `@ai-sdk/anthropic` may inject the oauth beta itself for `authToken`
requests. **I could not verify this** — the workspace deps are not installed in
this environment (`node_modules/@ai-sdk/anthropic` is absent) and outbound
network is blocked, so the SDK could not be inspected and the request could not
be reproduced live. If fixing #1 and #2 doesn't fully resolve things, make this
provider reuse `getAnthropicHeaders()` so the chat path carries the same
`anthropic-beta` / `anthropic-version` as every other Anthropic call.

---

## Minor, unrelated observation

`agent.ts:836` gates adaptive thinking on a hardcoded model string:

```ts
const isOpus47 = this.config.model === "claude-opus-4-7";
```

The failing model is `claude-opus-4-8`, so it silently takes the non-adaptive
`thinking: { type: "enabled", budgetTokens }` branch. Not related to the 401, but
that literal will need updating for opus-4-8 to get adaptive thinking.

---

## Recommended fixes

In priority order:

### 1. Stop freezing the token in the cached Agent (fixes the new-vs-old-tab bug)

Pick one of:

- **Re-resolve credentials per `run()` for `anthropic` keys**, instead of caching
  them in the Agent's config. e.g. have the Agent pull the access token through a
  callback/getter at request time (`() => refreshAccountCredentials(account)`),
  so each `run()` uses the live DB token. This is the cleanest fix.
- **Or** invalidate the cached Agent when its captured token is near/after
  expiry. Add an expiry check to the cache-invalidation gate in
  `getOrCreateAgentForTab` (store the captured `expiresAt` on `tabAgent` and null
  the agent when `Date.now() > expiresAt - 60_000`). Coarser, but localized.
- **Or** when a refresh rotates the DB token, proactively null every cached
  `tabAgent.agent` whose `keyId` matches, forcing re-resolution on next send.

The getter approach is preferred because it also survives token rotation
(root-cause note above) without any cache bookkeeping.

### 2. Fix the OAuth refresh call in `credentials/claude.ts`

- `OAUTH_TOKEN_URL` → `https://api.anthropic.com/v1/oauth/token`.
- In `refreshViaOAuth`, send JSON: `Content-Type: application/json`,
  `Accept: application/json`, `body: JSON.stringify({ grant_type, client_id, refresh_token })`.
- Don't swallow failures silently — log `response.status` and the body so the
  next stale-token event is diagnosable. (Mirror the reference's `postJson`,
  which throws with `status` + `body` included.)

### 3. (If still needed) add `anthropic-beta` to the chat provider

Have `createClaudeOAuthProvider` reuse `getAnthropicHeaders(token)` so the chat
path carries `anthropic-beta` (incl. `oauth-2025-04-20`) and `anthropic-version`
like every reference path and every other Anthropic call in this repo.

---

## What was verified vs. assumed

- **Verified by reading the code:** the per-tab Agent cache, the cache-invalidation
  gate that ignores token expiry, the frozen `claudeCredentials` flowing into the
  provider, the wrong refresh URL + form-encoded body, the silent failure +
  stale-token fallback, the missing `anthropic-beta` on the chat provider, the
  `opus-4-7` hardcode.
- **Verified against the reference** (`references/oh-my-pi`): correct token URL
  (`api.anthropic.com/v1/oauth/token`), JSON body, and that the OAuth chat path
  sends `anthropic-beta`.
- **Could not run/reproduce:** deps aren't installed here and network is
  sandboxed, so the live request, the SDK's default-header behavior, and the
  exact DB token `expiresAt` values were not inspected. Root cause #1 fully
  explains the reported new-vs-old-tab behavior on its own; #2 explains why the
  system can't self-heal once the DB token lapses.
