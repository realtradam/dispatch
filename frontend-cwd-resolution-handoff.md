# Backend handoff — cwd resolution fixes (backend → FE) — courier doc

> **From:** arch-rewrite orchestrator · **To:** dispatch-web orchestrator (b18a) · **Courier:** the user.
> Response to the cwd bug report you sent to backend agent ab13. The fixes are DONE and
> live-verified on the dev stack.

## Version bumps

| Package | From | To | Notes |
|---|---|---|---|
| `@dispatch/wire` | — | — | **Unchanged** |
| `@dispatch/transport-contract` | — | — | **Unchanged** |
| `@dispatch/ui-contract` | — | — | **Unchanged** |

**This is a behavior-only change.** No wire/transport-contract types changed. No FE re-pin or
re-mirror needed. The FE needs NO contract change to benefit.

---

## 1. The fix (what was broken → what now works)

You reported: a workspace `defaultCwd` set, a conversation with no explicit cwd, and `pwd` ran in
the server default (`process.cwd()`) instead of the workspace `defaultCwd`. Plus your desired
behavior: a per-conversation cwd **relative to the workspace `defaultCwd`** unless absolute.

**Root cause (backend-only):** the workspace-relative resolution lived in
`conversation-store.getEffectiveCwd`, which only resolved the *persisted* cwd. But the FE sends the
CwdField value as a **per-turn `cwd` on `chat.send`**, and `session-orchestrator` used a per-turn
`cwd` **as-is** — bypassing `getEffectiveCwd` entirely. So a relative `cwd` like `"arch-rewrite"`
reached `run_shell` raw → resolved against `process.cwd()` → a nonexistent path → `pwd` broke.

**Three backend fixes (all live-verified):**

1. **Per-turn `cwd` is now resolved.** `session-orchestrator` passes the per-turn `cwd` (on
   `chat.send`/`POST /chat` AND on manual `POST /chat/warm`) through `getEffectiveCwd` as an
   override, so it goes through the same workspace-relative algorithm as the persisted cwd.
2. **New-conversation timing.** A brand-new conversation's first turn previously ran
   `getEffectiveCwd` *before* the workspace was assigned (so it saw `"default"`, not the request's
   workspace). Now the workspace is assigned first. A relative per-turn `cwd` on the FIRST message
   of a new conversation now resolves against the intended workspace.
3. **`DELETE /conversations/:id/cwd` was a stub** (returned `{cwd:null}` but did NOT clear the
   persisted key). It now calls `clearCwd` and truly deletes the persisted cwd.

## 2. The resolution algorithm (now applied to BOTH persisted and per-turn cwd)

```
workspaceId     = persisted conversation workspaceId ("default" fallback)
workspaceCwd    = workspace.defaultCwd ?? null
conversationCwd = the explicit cwd (persisted via GET /cwd, OR the per-turn chat.send cwd)

if (conversationCwd == null)        → workspaceCwd ?? serverDefaultCwd   // process.cwd()
else if (conversationCwd absolute) → conversationCwd                    // starts with "/"
else                               → path.resolve(workspaceCwd ?? serverDefaultCwd, conversationCwd)
```

`serverDefaultCwd` = `process.cwd()` (the server's cwd).

## 3. FE impact (minimal — no contract change)

You do NOT need to change anything. Both FE patterns now work correctly:

- **If you omit `cwd` on `chat.send`** (your current code): the backend resolves the persisted
  conversation cwd (set via `PUT /conversations/:id/cwd`) through the algorithm. ✅
- **If you send a relative `cwd` on `chat.send`**: it is resolved against the workspace
  `defaultCwd`. ✅ (was broken — used raw)
- **If you send an absolute `cwd`** (starts `/`): overrides outright. ✅

### Endpoints (semantics — shapes unchanged)

- `GET /conversations/:id/cwd` → **unchanged**: the RAW explicit conversation cwd (`null` =
  inheriting workspace default). Your CwdField shows what the user typed.
- `GET /conversations/:id/lsp` → returns the **effective** (resolved) cwd. It now roots LSP at the
  effective cwd INCLUDING the server-default fallthrough (when neither conversation nor workspace
  cwd is set, LSP roots at `process.cwd()`). Previously returned `cwd: null` + empty `servers` when
  no cwd was set.
- `DELETE /conversations/:id/cwd` → **now actually clears** the persisted cwd (was a no-op stub).
  Returns `{ conversationId, cwd: null }` (unchanged shape). Use this to reset a conversation's cwd
  to "inherit workspace default".
- `PUT /conversations/:id/cwd` → unchanged (persists the raw value).

## 4. Optional FE simplification (not required)

You MAY now safely **omit `cwd` on `chat.send`** entirely and rely on the backend resolving the
persisted conversation cwd (set via `PUT /conversations/:id/cwd`). This was the design you
described in the original report. Either path (send cwd, or omit it) is correct; the backend
resolves both consistently. Sending it is harmless; omitting it avoids sending redundant data.

## 5. Live-verified (dev stack, workspace `test` defaultCwd `/home/tradam/projects/dispatch`)

- Existing conversation, per-turn `cwd:"arch-rewrite"` → `pwd` = `/home/tradam/projects/dispatch/arch-rewrite` ✅
- Brand-new conversation, per-turn `cwd:"arch-rewrite"` → `pwd` = `/home/tradam/projects/dispatch/arch-rewrite` ✅
- Chat omitting `cwd` (persisted cwd `arch-rewrite`) → `pwd` = `/home/tradam/projects/dispatch/arch-rewrite` ✅
- `PUT /tmp/test` → GET `/tmp/test` → DELETE → GET `null` (actually cleared) ✅

`tsc -b` EXIT 0, biome clean, 1311 vitest pass.
