# Excalidraw live editor — plan (feature/excalidraw-live-editor)

> Lead planner/orchestrator: Opus (this conversation). Design decisions are owned by Opus.
> Backend implementation: Flash agents, strictly to the briefs below (no design discretion —
> any ambiguity → STOP and report to Opus). Frontend planning + coding: Opus only.

## 1. The request (user)

"Open" `.excalidraw` files in the file viewer and edit them there; the AI can also edit them
live (hot-reload style, no manual reload). Inspiration: <https://github.com/excalidraw/cli>.

Approved interaction rules (binding):
1. Canvas edits autosave to the `.excalidraw` file.
2. AI changes to the file appear automatically in the open canvas.
3. Updates preserve current zoom and pan.
4. Our own saves don't trigger a reload loop.
5. An incomplete/invalid external write leaves the last valid drawing visible until valid again.
6. Turn-taking, not simultaneous collaboration: no locking, conflict dialogs, or shape merging (v1).
7. No external update is applied mid-drag / mid-text-edit; apply when the interaction finishes.
   Otherwise the file is the shared source of truth; the latest completed edit wins.

## 2. Research findings

- **excalidraw/cli** (`@excalidraw/cli` 1.1.x): renders `.excalidraw` → PNG/SVG, Mermaid →
  Excalidraw, Excalidraw+ workspace management, MCP tools. Not an embeddable editor. The useful
  takeaways are its *file model*: a scene file "only needs `elements`; missing fields are filled
  in" (restore semantics), and whole-file `put` = "file is the source of truth; editors that have
  the scene open reload it" — exactly our model. `patch` merges elements by id/`version`; we
  deliberately do NOT do element merging in v1 (rule 6).
- **Editor**: `@excalidraw/excalidraw` 0.18.1 (React 17/18/19 peer). Relevant API:
  `excalidrawAPI.updateScene({ elements, appState?, captureUpdate })` — omitting `appState`
  scroll/zoom keeps the viewport (rule 3); `CaptureUpdateAction.NEVER` is the documented mode for
  remote/external updates (kept out of undo). `onChange(elements, appState, files)`,
  `onPointerDown/onPointerUp`, `getSceneElementsIncludingDeleted`, `getFiles`, `addFiles`,
  `serializeAsJSON`, `restore`/`restoreElements` (fills missing element fields → AI may write
  minimal elements), `getSceneVersion`. AppState exposes in-progress interaction flags
  (`newElement`, `editingTextElement`, `resizingElement`, `selectedElementsAreBeingDragged`,
  `multiElement`, …) used to defer external updates (rule 7).
- **Existing Dispatch seam** (`feature/file-viewer`, transport-contract 0.28.0): read-only
  `GET /conversations/:id/text-file` (256 KiB cap, opaque `version`), stat-only
  `GET …/text-file-version` polled ~1 s by the FE live-reload poller, context guards, no symlinks,
  remote computers → 422. The FE opens files via embed "Open in file viewer" and `file-link:` links.

## 3. Technical approach (decided)

The file on disk is the single source of truth. The AI edits it with its ordinary file tools
(`write_file`/`edit_file`) — no new AI tool is needed. The FE renders `.excalidraw` tabs of the
existing file viewer with the real Excalidraw React editor (lazy-loaded), detects external writes
with the existing version poller, and autosaves through a NEW conditional write endpoint.

### 3.1 Backend (this repo) — extend existing units, no new extension

Boundary choice: the write is a sibling of the existing text-file routes, so it extends
`transport-http` (route) and `system-prompt` (model guidance). No new extension/package, no
tier change, no new glossary term (we use Excalidraw's own "scene"/"drawing" in prose only).

**Contract `@dispatch/transport-contract` 0.29.0 (additive; authored by Opus):**
- `PUT /conversations/:id/text-file`, body `TextFileWriteRequest`
  `{ path, text, expectedVersion, expectedCwd?, expectedComputerId? }` →
  200 `TextFileWriteResponse { path, version, bytes, maxBytes }`.
- Conditional (compare-and-swap): `expectedVersion` is REQUIRED and must equal the file's current
  version, else **412** with `TextFileWriteConflictResponse { error, version }` (current version).
- Writable only for paths ending `.excalidraw` (case-insensitive) → otherwise **403**. Existing
  regular files only (missing → 404; no create; final-component symlink → 400). Same path rule,
  context resolution, guards (409) and remote-computer refusal (422) as `/text-file`.
- Body validation: strict UTF-8 JSON body; `text` free of binary control chars (400); `text`
  must parse as a JSON object with `type === "excalidraw"` and an `elements` array (400);
  `text` UTF-8 size > path cap → 413.
- Atomic replace: temp file in the same directory → write → fsync → chmod to original mode →
  fstat (version) → rename over target. Readers/pollers never see a partial browser save.
- Per-path size cap (read, version and write): **16 MiB (16777216) for `.excalidraw`**,
  256 KiB for every other text file. `TextFileResponse.maxBytes` reports the path's cap. Rationale:
  scenes embed images as data URLs and routinely exceed 256 KiB.
- `Cache-Control: no-store`; log path + bytes (never content).

**System-prompt guidance:** append an "## Live Excalidraw drawings" section (exact text in the
system-prompt brief) to the mandatory text-file guidance, with a non-duplicating upgrade path for
templates that already end with either previous guidance variant.

### 3.2 Frontend (../frontend) — Opus plans + codes

Binding decisions handed to the FE Opus (FE-internal design is otherwise theirs):
- `.excalidraw` (case-insensitive) tabs in the file viewer render an Excalidraw canvas instead
  of CodeView; React + `@excalidraw/excalidraw` lazy-loaded (dynamic import) so the main bundle
  is not affected; editor assets/fonts self-hosted (no third-party CDN at runtime).
- Load/parse via `restore()`; invalid/incomplete content → keep last valid drawing + a
  non-blocking status (rule 5); never save while showing a stale-because-invalid state without a
  valid base.
- External change (poller version ≠ last known) → re-read → if mid-interaction, queue latest and
  apply on interaction end (rule 7) → `updateScene` with elements (+ files, +
  `viewBackgroundColor`), never scroll/zoom, `CaptureUpdateAction.NEVER` (rule 3).
- Autosave only on scene-content changes (not zoom/pan/selection), debounced shortly after the
  interaction ends, via PUT with `expectedVersion` = last known version; adopt the returned
  `version` so the poller does not reload our own save (rule 4).
- **412 policy (Opus decision):** the on-disk file wins — it is the latest edit that reached the
  shared source of truth. Re-read and apply it (subject to rule 7) and show a non-blocking toast
  that the last canvas change was not saved because the file changed on disk. No dialog, no merge.
- Remote-computer conversations: the canvas is unavailable (422) — degrade like the file viewer.

## 4. Units, owners, waves

| Wave | Unit | Owner | Files |
|---|---|---|---|
| 0 | contract `packages/transport-contract` (types + type tests, 0.29.0) | Opus (me) | `packages/transport-contract/**` |
| 1 | `packages/transport-http` (PUT route, per-path cap, write logic, tests) | Flash | `packages/transport-http/**` |
| 1 | `packages/system-prompt` (guidance section + upgrade path, tests) | Flash | `packages/system-prompt/**` |
| 1 | frontend (plan + implement) | Opus | `../frontend/**` |
| 2 | verification, live probe, docs, commits | Opus (me) | `tasks.md`, `notes/`, lockfile |

Wave 1 runs in parallel: the contract is fixed first, so FE and backend never wait on each other
except for the FE's final live probe (notified when the backend wave is green).

## 5. Progress log

- [x] Research CLI + editor API; design; plan written.
- [ ] Wave 0: contract 0.29.0 authored + typecheck.
- [ ] Wave 1: transport-http (Flash) · system-prompt (Flash) · frontend (Opus).
- [ ] Wave 2: verification, live probe, docs, commits (feature branches only; no merge/push).
