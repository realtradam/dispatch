# Text-file embeds — implementation report

## Delivered behavior and syntax

Save the document completely, then emit a short summary and a **standalone paragraph**:

```markdown
I saved the implementation plan; the key change is the new validation boundary.

[Implementation plan](text-file:notes/plan.md)
```

Absolute path and filename encoding examples:

```markdown
[Research](text-file:/tmp/research.md)

[Research with spaces](<text-file:notes/research%20report.md>)

[Literal percent](text-file:notes/100%25.md)
```

The prefix is exactly `text-file:` (not image syntax). Destinations are POSIX
absolute paths or paths relative to the conversation's authoritative effective
working directory. Angle-bracket destinations can also contain literal spaces.
Markdown escapes are interpreted by marked, then percent escapes are decoded
**once**. `%2520` denotes a literal `%20` filename; `%23` and `%3F` denote filename
`#` and `?`. The HTTP adapter uses URLSearchParams to transport that literal
filesystem path; the backend does not perform another destination decode.

Only a complete, single-line, top-level inline-link paragraph opts in. Ordinary
links, images, inline/fenced/indented code, reference-style links, titled links,
list/blockquote links, and links surrounded by prose retain ordinary Markdown
behavior and never trigger text-file reads. While streaming, an embed waits for
a blank-line paragraph boundary or completion of the message, avoiding speculative
fetches for incomplete links. Examples inside code never fetch. Unsupported or
malformed destinations remain inert ordinary Markdown, not browser/server URL
fetches. Raw HTML cannot forge a file-fetching block.

## Presentation

The document appears inside the existing **inset-well**, matching the recessed
panel style of tool-call/thinking blocks. It includes its label/path and
Refresh/Retry controls. Markdown extensions `.md`, `.markdown`, `.mdown`, `.mkd`,
`.mkdn` render through the existing marked/highlight.js/DOMPurify pipeline.
Other valid text/code files render safely as literal whitespace-preserving code,
without guessing a language or interpreting their HTML/Markdown.

The default preview renders approximately the **first six and last six source
lines**, with an omitted-source-line count. Files of twelve lines or fewer are
not duplicated. Expand document shows the full rendered document; Collapse
document returns to the preview. The control exposes `aria-expanded`.
Top-level code-fence context is restored around preview fragments. Previews are
source-line excerpts, not a six-visual-line layout clamp: wrapping, headings,
tables and multiline constructs can change their visual height/formatting. Some
constructs crossing excerpt boundaries (lists, tables, reference definitions,
raw HTML) are necessarily approximate; expansion renders the authoritative full
Markdown.

Both preview and full content are sanitized. Existing raw-HTML/link policy and
remote-image click consent are preserved. Omitted images are not mounted until
expansion. Relative local images resolve against the returned document's directory
through the existing local-image route. Embedded documents receive no text-file
client, so nested embed references are inert and cannot recursively fetch.

Loading, empty-file, transport/validation failure and retry states are visible;
failures do not break surrounding chat. File text is display data, never a
conversation/history mutation.

## File lifecycle and resource policy

- **Live view, not snapshot.** Only the short reference remains in stored chat.
  No document body or hash/snapshot is persisted with the message.
- A mounted chat fetches current disk bytes on first reference. Repeated exact
  decoded paths share an in-flight/result entry while subscribed. There is no
  file watcher or polling. Already displayed content does not update itself.
- Refresh (or Retry after failure) invalidates **all live files in that mounted
  chat**, refetches authoritative context, and rereads their current contents.
  This prevents mixing old and refreshed routing contexts. Expansion alone does
  not fetch. File deletion produces a not-found state on the next read; recreation
  can recover through Retry.
- When the last subscriber leaves, its entry is aborted/released. Returning to
  chat/reloading/remounting reads current disk state, which can differ from the
  original message. No historical immutability is implied.
- Known cwd/computer setting changes and conversation/workspace switches replace
  the context-bound client, abort old requests and discard its cache. Late
  responses cannot publish into a new client/path. External context edits not
  signaled to the UI are detected by backend guards on subsequent reads or by
  Refresh; existing displayed text is not watched for external changes.
- Limit **256 KiB (262144 bytes)** per file, strict UTF-8, allowing tab/LF/CR but
  rejecting NUL and other C0/C1 binary controls. Exactly the limit is accepted;
  oversize files are rejected, never silently truncated.
- At most **8 embeds per message**, **32 active distinct paths per mounted chat**
  (at most 8 MiB source text), and **4 concurrent file loads**. The per-message
  limit is explained inline; active-cache overflow has a visible error.
- Backend opens a single nonblocking/no-follow descriptor, checks regular-file
  status and reads at most limit+1 bytes, including a final growth check. FIFOs,
  devices, directories and final-component symlinks are rejected. Ancestor
  directory symlinks and ordinary `..`/absolute paths are allowed: this is **not a
  cwd sandbox**. Reads have a byte/work bound but no special filesystem timeout
  or guarantee of a coherent snapshot while another process modifies a file.

Unsupported: file URLs, HTTP/network destinations, tilde expansion, Windows paths,
backslashes, control characters and remote-computer embeds. Remote targets are
explicitly rejected, never read from an identically named local path.

## Backend seam and trust boundary

Existing `transport-http` is extended; no new extension/tier or kernel feature.
Additive `transport-contract` interfaces are `TextFileQuery`, `TextFileResponse`,
`TextFileContextResponse`; package version remains 0.26.0 with local `file:` deps,
and the frontend's tracked public contract mirror is updated.

```text
GET /conversations/:id/text-file-context
  -> { conversationId, cwd: string|null, computerId: string|null }

GET /conversations/:id/text-file?path=...&expectedCwd=...&expectedComputerId=...
  -> { path, text, format: "markdown"|"text", bytes, maxBytes }
```

Context preflight performs no LSP or file work. Both routes resolve persisted
conversation settings and workspace defaults server-side, not browser state or
server process cwd. Relative conversation cwd is resolved against an absolute
workspace default; an unresolvable configured relative cwd returns 422. With no
cwd configured, context is null, absolute local file references work, and relative
file references return 400. The frontend always supplies both preflight-derived
guards. Empty guard values assert unset cwd/local computer; absent guards skip
comparison. Guards never override server routing. The route rechecks context
after I/O before returning successful text.

All endpoint responses use `Cache-Control: no-store`, including middleware errors.
Relevant statuses: 400 invalid/non-text/nonregular, 403 unreadable or rejected
Origin, 404 unknown conversation/missing file, 409 stale context, 413 oversized,
422 unsupported remote/unresolvable configured context, 500 read failure. Existing
Host rejection remains 421.

**Authentication limitation, explicitly audited:** this application currently uses
Host/Origin checks plus loopback/Tailscale deployment restrictions, not bearer or
per-user session authentication. The new routes retain exactly that existing trust
boundary; they do not invent an authentication guarantee. A trusted client with
access to this API can read supported local files accessible to the backend UID,
including absolute paths outside cwd. Do not expose this transport publicly or to
untrusted users. No arbitrary HTTP fetch is added.

## Initial AI context, custom prompts and persistence

Mandatory application guidance is appended **after template variable resolution**
in `SystemPromptService.construct`. The unchanged default template and exact
user-authored custom-template bytes are preserved. An empty custom template now
constructs guidance-only context. Guidance includes actual syntax/examples,
save-before-reference, short summaries, supported paths/limits, local-only/live
semantics, preview/expand behavior and the distinction between user display and
reading a file for the model's own understanding.

New conversations and normal prompt reconstruction (compaction, missing resolved
prompt, cwd/computer metadata invalidation) receive it, including installations
with existing custom templates. Resolved prompts remain persisted per conversation.
Existing matching resolved prompts, including legacy empty prompts, are returned
**byte-for-byte unchanged** until ordinary reconstruction; changing the global
template alone does not retrofit existing conversations. There is no migration or
read-time mutation. The pure suffix-idempotent `appendTextFileGuidance` helper is
also used for missing/stale read-only cache-warming assembly, yielding the same
provider system prompt as the next real turn without warm persistence writes.
Generic `resolveText` remains generic and does not append application guidance.

The session-orchestrator tests capture actual provider requests using real prompt
service, conversation store, assembly and kernel turn loop: default/custom first
turns, legacy continued/warm prompts, missing/cwd/computer invalidation, warm/real
parity, compaction and later reuse. History retains the reference, not the file
body. This is verified delivery, not merely a default-string assertion.

Explicit caller-owned per-turn `systemPrompt` overrides (e.g. heartbeat) retain
their existing **AS-IS bypass** contract; they do not receive appended guidance.
The initial instructions in already-running/persisted conversations are not
retroactively changed, and this task did not redeploy/restart the shared service.

## Verification

`bun install` completed inside both feature worktrees before build/testing; frontend
was refreshed after backend declarations were built. All work is on
`feature/text-file-embeds`, with no merge or push. After the user's stop request,
all delegated generations were stopped and the lead completed fixes, tests,
verification, documentation and commits directly; no further subagents.

### Frontend

- `bun run typecheck`: **0 errors / 0 warnings**.
- `bun run check`: clean, 308 files (no warnings/infos).
- `NODE_OPTIONS=--no-experimental-webstorage bun run test`: **2586 passed,
  2 opt-in live tests skipped**, twice, 130 passed files / one skipped file.
- Markdown-specific tests: **236 passed** (parser, streaming, sanitized UI,
  image consent, head/tail/expand, code/plain text, request effects and limits).
- `bun run build`: succeeds; existing Svelte initial-value capture diagnostics
  and large-chunk advisory remain.
- `TEXT_FILE_LIVE_PROBE=1 bunx vitest run scripts/text-file-live.test.ts`:
  **2 passed** against a freshly spawned ephemeral Bun HTTP app using a real
  conversation store and temp disk files. The actual Svelte component and client
  render a saved plan from only summary+reference, expand the omitted middle,
  refresh updated content, remount/reload current bytes, show deletion, recover on
  Retry and reject authoritative remote context. The fixture process/files are
  cleaned up. No deployed service is used or restarted.
- Plain `bun run test` on host **Node v26.11.1** reproduces 26 pre-existing
  localStorage-related failures in untouched `tile-layout-store` and
  `WorkspacesHome` suites. A temporary `git archive HEAD` baseline with the same
  dependencies independently reproduced exactly those 26 failures. Disabling
  Node's experimental Web Storage lets jsdom supply browser storage and makes
  the whole suite pass; no unrelated application/test code was modified for this.

### Backend

- `bun run typecheck`: succeeds.
- `bun run test`: **4277 passed / 10 skipped**, 221 passed files / one skipped.
- `bun run test:bun`: **190 passed / 0 failed**, including two real ephemeral
  loopback text-file HTTP tests in the standard Bun test target.
- `bun run check`: clean, 754 files (no warnings/infos).
- `bun build packages/host-bin/src/main.ts --compile --outfile dist/dispatch-server --minify`
  and equivalent CLI compile: both succeed, worktree-local ignored outputs only.
- Standard `bin/build --no-frontend` cannot complete here: its existing sibling
  `claude` symlink points at the separate main Claude checkout, where bundling
  fails resolving `@dispatch/kernel`. The wrapper may have refreshed ignored compiler outputs there before failing;
  no dependency install or tracked edits were made there; the standalone feature backend/CLI compile above is the verified
  build. External Claude bundling is **not** claimed verified.
- Backend tests cover pure path/query/encoding policy, effective context,
  strict UTF-8/binary/empty/exact-limit/oversize files, directories/devices/FIFO/
  symlink refusal, unknown conversation, stale guards, remote inheritance with
  an existing local path, live changes/deletion and Host/Origin rejection.
- `git diff --check` clean in both repositories. No probe server/collector leaks.

### Remaining manual validation

Automated UI tests use jsdom, not a graphical browser. After deploying both
commits, visually confirm block styling/responsiveness on desktop/mobile, expand
and collapse a longer Markdown plan, and click a remote-image consent button.
No screenshots, graphical-browser layout check, AI-provider-generated live reply,
remote file support, watchers, snapshots or editor/attachment redesign are claimed.
