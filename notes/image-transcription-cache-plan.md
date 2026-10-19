# Plan — Image transcription cache + per-turn image resolution

Status: ready to implement
Branch: `feature/image-transcription-cache`
Packages touched: `conversation-store`, `vision-handoff`. No kernel change.
No frontend change.

---

## 1. Why (measured on the production DB, `/var/lib/dispatch/dispatch.db`)

### 1.1 Transcription cache is one giant blob keyed by full images
`ConversationStore.setImageTranscription` (`packages/conversation-store/src/store.ts`
~L1513) stores **one JSON object per conversation** under
`conv:<id>:image-transcriptions`, mapping **image URL → transcription text**.
The URL is the *resolved base64 data URL*, so the keys are entire images.

- 12 such blobs, **72 MB total**: 168 entries = **72.0 MB of keys, 0.46 MB of
  text**. Largest single value: **37 MB**.
- Every new transcription does read → `JSON.parse` → copy into a Map → rebuild
  object → `JSON.stringify` → write of the **whole** blob (O(total) per image).
- Every turn on a vision model with more images than the limit loads and parses
  the whole blob (`getImageTranscriptions`).

### 1.2 Every image is read and base64-encoded every turn
`prepareForProvider` (`packages/vision-handoff/src/service.ts` ~L510) calls
`resolveImageUrlsInMessages` **first**, which reads every `/images/<conv>/<id>`
file from disk and base64-encodes it — for **all** images in history — before
compaction decides that only the newest `imageLimit` (default 10) are sent
natively. Transcribed images are encoded and then thrown away, every turn.
The non-vision branch also resolves everything and stores the **data URLs** in
the module-level `imageRegistry` Map (per conversation, never trimmed) — all
images held in RAM as base64 strings.

### 1.3 Temp-image cleanup is dead code — and would crash if it worked
Compaction runs on the *resolved* messages, so `entry.url` is a `data:` URL.
`deleteTmpImage(entry.url)` returns immediately unless the URL starts with
`/images/` — so transcribed images are **never deleted**. If it *did* delete
them, the next turn's `resolveImageUrl` would `readFile` a missing file and
throw out of `prepareForProvider`, failing the turn.

The same failure already exists today whenever a temp file is gone: the image
dir defaults to `/tmp/dispatch/images` (`DISPATCH_IMAGE_DIR`), which typically
does not survive a reboot. History currently has **340 chunks with compact
`/images/...` URLs** whose files may no longer exist (the dir currently holds
4 conversations, 64 KB). `resolveImageUrl` throwing → turn failure.

### 1.4 Both URL forms are live
Persisted history contains **1187 chunks with inline `data:image/...` URLs**
(legacy) and **340 chunks with compact `/images/<conv>/<id>` URLs** (current).
The design must handle both.

## 2. Goals

1. Transcription cache = **one small row per image**, keyed by a fixed-size
   hash; set = a single small write, get = only the entries needed.
2. Only resolve (read + encode) images that are actually sent to a provider or
   that need a fresh transcription. Already-transcribed images are never read.
3. Temp-image cleanup after transcription actually works, safely.
4. A missing image file never fails a turn.
5. Existing cached transcriptions are migrated where possible; no data loss
   for legacy inline-data-URL conversations.

## 3. Design

### 3.1 Cache key = hash of the **persisted** chunk URL
The key must be derived from the URL **as stored in history** (the compact
`/images/...` URL, or the legacy inline `data:` URL) — not the resolved data URL.
This makes the key stable, independent of whether the temp file still exists,
and cheap to compute without reading the image.

Key layout (in `packages/conversation-store/src/keys.ts`):
```
conv:<id>:image-transcription:<sha256-hex(persistedUrl)>   → transcription text
```
- Note the **singular** `image-transcription:` + colon: the prefix
  `conv:<id>:image-transcription:` does **not** match the legacy
  `conv:<id>:image-transcriptions` key, so prefix scans can't confuse them.
- Check every existing `storage.keys("conv:…")` prefix scan in `store.ts`
  (e.g. ~L872, ~L947, ~L987, ~L1088) still behaves correctly with the new keys.
- Hashing: pick what fits the package's rules (AGENTS.md: effects at the edges).
  `conversation-store` is core and is the I/O shell for storage; using a hash
  from the runtime (`node:crypto` / `Bun.CryptoHasher`) there is fine, or
  inject a `hash` dep. Keep the hash function in one place.

### 3.2 Store API (`packages/conversation-store/src/store.ts`)
Replace the whole-map API:
- `getImageTranscriptions(conversationId, urls: readonly string[]):
  Promise<ReadonlyMap<string, string>>` — fetch only the requested URLs
  (returned map keyed by the original URL).
- `setImageTranscription(conversationId, url, text)` — **one** `storage.set`
  of one small row. No read-modify-write.
- `deleteConversation`-style cleanup (~L1213–1235): delete all
  `conv:<id>:image-transcription:` rows by prefix, plus the legacy key.
- Update the matching optional deps in `vision-handoff/src/service.ts`
  (~L88–100) and the wiring in `vision-handoff/src/extension.ts` (~L186–192).
- Use `lsp references` to find every consumer of the old signatures.

### 3.3 One-time migration (startup, idempotent)
Follow the existing precedent `migrateLegacyOpenCodeModels`
(`store.ts` ~L1084, invoked from `conversation-store/src/extension.ts` ~L27).

For each `conv:<id>:image-transcriptions` key, one at a time (bounded memory —
the largest is 37 MB):
1. Parse it. For each `(url, text)`: write
   `conv:<id>:image-transcription:<sha256(url)>` = text.
   - For legacy conversations whose history stores the **inline data URL**,
     `sha256(old key)` equals `sha256(persisted URL)` → cache preserved.
   - For compact-URL images, the old key was the *resolved* data URL, which no
     longer matches the persisted compact URL. Optionally map them: scan that
     conversation's image chunks; for each compact URL whose temp file still
     exists, resolve it and, if the resolved data URL is in the old map, write
     the row under `sha256(compactUrl)`. Entries that can't be mapped are
     dropped (they'll be re-transcribed once, on demand). Note this in the
     report.
2. Delete the legacy key.
3. Log counts (migrated / mapped / dropped).

Do **not** auto-`VACUUM` the 1 GB DB at startup (slow, blocks boot). Mention a
manual `VACUUM` in the report as an optional follow-up.

### 3.4 Resolve lazily in `vision-handoff` (`service.ts`)
Restructure `prepareForProvider` so it **does not resolve up front**:

**Vision-capable branch (`compactImagesForVisionModel`)**
1. Collect image entries from the *unresolved* messages (persisted URLs).
2. If `count <= limit` → resolve only those images and return.
3. Otherwise, split into `toTranscribe` (oldest `count − limit`) and `keepNative`
   (newest `limit`).
4. `getImageTranscriptions(convId, toTranscribe.map(url))` — only those URLs.
5. For cache misses only: resolve that one image → send to the vision model →
   `setImageTranscription(convId, persistedUrl, text)` → on success,
   `deleteTmpImage(persistedUrl)` (now receives the compact URL, so cleanup
   actually runs). Failure placeholders stay uncached (as today) and the file
   is **not** deleted on failure or abort.
6. Resolve only `keepNative` images for the provider payload.

**Non-vision branch (placeholders + `consult_vision`)**
- Placeholder substitution needs no image bytes — don't resolve at all.
- Store the **persisted URL** (not the data URL) in `imageRegistry`; resolve
  lazily inside `consultVision` when an image is actually consulted.
- Check how `consultVision` consumes registered images and resolve at that point.

### 3.5 Missing image file never fails a turn
Make resolution failure-tolerant (ENOENT or any read error):
- For an image that would be sent natively: if a cached transcription exists,
  use it as text; otherwise substitute a short text placeholder, e.g.
  `[Image unavailable — the original file is no longer on disk.]`.
- For an image that needs transcription: substitute the same placeholder (do not
  cache it, so it can be retried if the file reappears).
- Log at warn level with conversation id + URL (not the bytes).
This also covers the "user raises `imageLimit` after transcribed images were
deleted" case.

## 4. Out of scope (note in report as follow-ups)
- The 1187 legacy chunks that embed full base64 images inline in history (bulk
  of the ~893 MB of `conv:` data). Migrating them to compact URLs on disk is a
  separate, larger change.
- Moving the image dir off `/tmp` so images survive reboots.
- Manual `VACUUM` to reclaim freed pages.

## 5. Tests (AGENTS.md: strict pure core, lenient shell)
conversation-store (in-memory storage backend):
- set/get round trip by URL; get with a subset of URLs returns only those;
  set is a single write (no read of other rows).
- Prefix isolation: new keys vs legacy `…:image-transcriptions` key.
- Delete-conversation removes all transcription rows + legacy key.
- Migration: legacy blob → per-image rows keyed by `sha256(url)`; idempotent on
  second run; legacy key deleted; malformed blob handled (logged, skipped).

vision-handoff (fake store deps, fake resolver, fake vision provider):
- With N > limit images: the resolver is called **only** for the `limit` native
  images plus cache misses — never for cached transcribed images.
- Cache miss → transcribed once → `setImageTranscription` called with the
  **persisted** URL → `deleteTmpImage` called with the compact URL.
- Second turn: zero transcription calls, zero resolver calls for those images.
- Resolver throws ENOENT for a native image → placeholder/cached text, turn
  proceeds (no throw).
- Abort mid-transcription: no cache write, no delete.
- Non-vision branch: no resolver calls during `prepareForProvider`; registry
  holds persisted URLs; `consultVision` resolves on use.

## 6. Verification gate
`bun install`, `bun run typecheck`, `bun run test`, `bun run test:bun` (if
storage tests touched), `bun run check` — all green. Optionally run `bin/up`
from `worktrees/image-transcription-cache/` (stop any running stack first) and
send >10 images in a conversation on a vision model to confirm compaction,
caching, and temp-file deletion. **Do not run the migration against the
production DB** (`/var/lib/dispatch/dispatch.db`) — test on a copy if needed.
Commit to `feature/image-transcription-cache` only. Do not merge or push.
Write the report per AGENTS.md "Reports".
