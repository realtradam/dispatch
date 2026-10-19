# Feature: local-image-markdown

**Goal:** Agents can show the user images in chat purely via Markdown — `![alt](/absolute/path/to/image.png)` or `file:///…` — with no tool call. The chat UI renders them inline.

**Repos:** backend AND frontend (separate worktrees of the same feature branch `feature/local-image-markdown`; the API contract below is FIXED — do not change it unilaterally).

**Out of scope / decisions already made:**
- **Raster images only** — png, jpg, jpeg, webp, gif, bmp. **SVG is intentionally excluded** (XSS vector via embedded scripts).
- No auth changes on the route (the API is unauthenticated today; the extension whitelist + magic-byte sniff bounds the exposure to actual image files).
- Stored custom system-prompt templates are NOT migrated — only `DEFAULT_TEMPLATE` changes. If a stored template exists it overrides the default; just note this in the summary, do not attempt migration.

---

## Backend (packages: `transport-http`, `system-prompt`)

### 1. New route `GET /local-image` in `packages/transport-http/src/app.ts`

Place it next to the existing tmp-image route (`app.get("/images/:conversationId/:imageId", …)`), mirroring its style (dynamic `node:path` / `node:fs/promises` imports, same response shape).

**Contract (pinned):**
- Query param: `path` — a URL-encoded absolute filesystem path to an image.
  - Expand a leading `~` to the OS home dir (agents often write `~/…`).
  - Reject with `400 { error: … }` if the decoded path is not absolute (after `~` expansion) or is empty.
- Extension whitelist (lowercase, after decode): `.png .jpg .jpeg .webp .gif .bmp` → MIME map (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/bmp`). Any other extension → `400`.
- **Magic-byte sniff** before serving (cheap header check per format, e.g. PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, WEBP `RIFF…WEBP`, BMP `BM`). Mismatch → `400`. This guarantees the endpoint can never serve a non-image file regardless of extension.
- Read failure (missing/unreadable) → `404 { error: "Image not found" }` (match the existing route's shape).
- Success: `Response(buf, { headers: { "Content-Type": <mime>, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" } })`.
- The endpoint intentionally serves ANY absolute image path on the machine — that is the feature (the agent already has shell/read access to the same machine). Do not add a root allowlist.

**Tests:** follow the existing transport-http app test conventions — 200 + correct MIME for a real temp image file per format, 400 for non-image extension, 400 for magic-byte mismatch (e.g. PNG bytes named `.png` vs text bytes named `.png`), 400 for relative path, 404 for missing file, `~` expansion.

### 2. System-prompt default template — `packages/system-prompt/src/service.ts`

Add to `DEFAULT_TEMPLATE` (after the cwd line) a paragraph telling agents the capability, e.g.:

```
You can show the user images directly in chat by embedding them in your Markdown
replies, e.g. ![description](/absolute/path/to/image.png). Local absolute paths
(and file:// URLs) are rendered inline by the chat UI; relative paths resolve
against the current working directory. Supported formats: png, jpg, jpeg, webp,
gif, bmp. No tool call is needed — just the Markdown image syntax.
```

(Exact wording may be polished; the capability, the syntax, and the format list must be present.) Update `service.test.ts` structure assertions if needed.

---

## Frontend (feature: `src/features/markdown`, wiring in `src/features/chat`)

### 3. Local-path image rewriting in `src/features/markdown/logic/markdown.ts`

Today `![x](file:///…)` and `![x](/home/…)` render broken: DOMPurify strips `file:` srcs, and a root-relative `/home/…` src 404s against the frontend origin. Remote `http(s)` images already work and must keep working.

**Required behavior — `renderMarkdown`, `renderMarkdownTail`, and `renderOpenFence` must all rewrite image srcs consistently (all three funnel through `sanitize()`):**

For each `<img>` produced by Markdown image syntax `![alt](src)`:
- `file:///path` → strip the scheme → local absolute path.
- `/absolute/path` → local absolute path.
- Relative path (no scheme, no leading `/`, not `data:`/`http(s)`) → resolve against the **conversation cwd** (threaded in as a render option; empty/absent cwd → leave as-is / no rewrite).
- `http(s)://…`, `data:` → leave untouched.

Rewritten src = `` `${apiBase}/local-image?path=${encodeURIComponent(absPath)}` `` — reuse the join-without-double-slash semantics of `src/core/chunks/image-url.ts` (`apiBase` may be empty → root-relative `/local-image?…`). `apiBase` and `cwd` are per-conversation render options, not module constants — thread them through as an opts parameter (e.g. `{ image?: { apiBase: string; cwd?: string | null } }`) from the render entry points. Whether you implement this via a DOMPurify `afterSanitizeAttributes` IMG hook (the module already uses this pattern for link `target=_blank`) or a pre-parse rewrite of the Markdown source is your call — cover Markdown image syntax at minimum; raw-HTML `<img>` tags in Markdown are best-effort.

### 4. Component threading — `Markdown.svelte` + `ChatView.svelte`

- `Markdown.svelte` (`src/features/markdown/ui/Markdown.svelte`): new optional prop carrying `{ apiBase: string; cwd?: string | null }`, forwarded into all render calls (including the streaming path via `advance`/`createStreamingMarkdown` — check `logic/streaming-markdown.ts` for how render opts flow).
- `ChatView.svelte` (renders `<Markdown text={…} streaming={…} />` around line 190): pass `apiBase` (the store already exposes the HTTP base, see how `resolveImageUrl` callers get it) and the conversation `cwd` (already reactive state in the app store — `$state cwd`, fetched via `GET /conversations/:id/cwd`).

### 5. Tests

Extend `src/features/markdown/logic/markdown.test.ts` (and streaming tests if the tail path is affected):
- `file:///home/u/pic.png` + apiBase `http://localhost:24203` → src `http://localhost:24203/local-image?path=%2Fhome%2Fu%2Fpic.png`.
- `/home/u/pic.png` with empty apiBase → root-relative `/local-image?path=…`.
- Relative `shot.png` with cwd `/w/foo` → `…/local-image?path=%2Fw%2Ffoo%2Fshot.png`; without cwd → untouched.
- `https://example.com/a.png` and `data:` URLs → untouched.
- Streaming tail render rewrites too.

---

## Definition of done (both repos)

- Backend: `bun install` then the repo's verification commands from AGENTS.md (typecheck / test / check / build) all green; route + template changes committed to `feature/local-image-markdown`.
- Frontend: same — all green, committed to `feature/local-image-markdown`.
- Manual smoke (report only, don't block): with the stack running, an agent message containing `![x](/abs/path.png)` shows the image inline.
- Do NOT merge or push. Commit to the feature branch only.
