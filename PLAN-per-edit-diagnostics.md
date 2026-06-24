# Plan — Live Per-Edit Diagnostics (General LSP)

> **Status:** APPROVED — implementing.

## Decisions (confirmed with user)

1. **Multi-server aggregation** — query ALL connected servers matching the file's extension, merge diagnostics tagged by source.
2. **Incremental sync** — capture each server's `textDocumentSync.change` during `initialize`; compute prefix/suffix diff ranges for `change: 2`; full content for `change: 1`. Generic, works for ALL LSPs.
3. **`languageId` mapping** — extend the existing `language.ts` with `.rb`/`.rbs`, `.c`/`.cpp`, etc.
4. **Auto-append to `edit_file`** — after a successful edit, run diagnostics on the post-edit buffer. Only append diagnostics if there are errors/warnings (severity ≤ 2). Don't append on clean edits (no noise).
5. **60s timeout** — if diagnostics take >10s, prepend a warning: "LSP is taking unusually long. If this happens more than once, raise it to the user." Always append this if slow, regardless of whether there are errors.
6. **General** — not Steep-specific. Works for any LSP server.

## Implementation waves

### Wave 1: `packages/lsp/` (single unit)

| File | Change |
|---|---|
| `src/diff.ts` (NEW) | Pure diff: `computeChangeRange(oldText, newText)` + `offsetToPosition(text, offset)` |
| `src/language.ts` | Add `.rb`/`.rbs` → `"ruby"`, `.c`/`.h` → `"c"`, `.cpp`/`.cc`/`.hpp` → `"cpp"` |
| `src/diagnostics.ts` | Add `hasReceivedPush(uri)` tracking, `clearReceived(uri)`, `formatFiltered(uri, minSeverity?)` |
| `src/client.ts` | Capture `textDocumentSync.change` from init; track open doc text; add `change(filePath, newText)` with incremental/full sync; fix `languageId` in `open()`; extend `waitForDiagnostics(filePath, opts?)` to accept `text` + `timeoutMs` + return `{ formatted, slow, timedOut }` |
| `src/tool.ts` | `diagnostics` op: query ALL matching connected servers (not just first); merge tagged by source |
| `src/types.ts` | Add `getDiagnostics(opts)` to `LspService` + `DiagnosticsResult` type |
| `src/extension.ts` | Implement `getDiagnostics` (calls manager → all matching clients → merge) |
| `src/diff.test.ts` (NEW) | Unit tests for diff functions |
| `src/tool.test.ts` | Multi-server aggregation test |
| `src/client.test.ts` | `change()`, `languageId`, `waitForDiagnostics` with text tests |

### Wave 2: `packages/tool-edit-file/` (cross-extension)

| File | Change |
|---|---|
| `src/extension.ts` | Import `lspServiceHandle` from `@dispatch/lsp`; `host.getService()` in activate; pass to tool |
| `src/edit-file.ts` | After successful edit: call `getDiagnostics({ filePath, text: newContent, cwd, minSeverity: 2, timeoutMs: 60_000 })`; append if errors; append slow warning if >10s |
| `package.json` | Add `@dispatch/lsp` dep |
| `tsconfig.json` | Add `@dispatch/lsp` reference |

### Wave 3: Build wiring (orchestrator)

- Root `tsconfig.json`: add `@dispatch/tool-edit-file` → `@dispatch/lsp` ref if needed
- `bun install` to link
- Verify: typecheck + test + biome
