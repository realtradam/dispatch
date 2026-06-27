# LSP Fixes Verification Report

## Executive Summary
The fixes implemented in `feature/lsp-fixes` successfully address the immediate crashes and the primary source of the 9.5 GB memory leak. The optional chaining fix, `fs.watch` error listener, bounded LRU document cache, and `initialize` timeout propagation are all correctly designed and do not introduce regressions. However, the memory leak fix for the diagnostics cache is **incomplete**: while actively opened documents are properly managed, diagnostics pushed for *unopened* background files will still accumulate and leak memory over time.

## Per-Fix Verification

### 1. Crash — TypeError from broken optional chaining (`client.ts`)
- **Correctness:** **Correct.** The addition of the second optional chaining operator (`void this.rpc?.handleMessage(msg)?.catch(...)`) correctly evaluates to `undefined` when `this.rpc` is null, preventing the synchronous `TypeError` that previously crashed the server.
- **Completeness:** **Complete.** Because `handleMessage` is an `async` function, it is guaranteed to return a Promise, meaning any internal errors are returned as rejections rather than synchronous throws.
- **New Issues/Regressions:** None. 

### 2. Crash — Unhandled 'error' event on `fs.watch` (`extension.ts`)
- **Correctness:** **Correct.** Attaching a no-op `'error'` listener to the `fs.watch` instance (`watcher.on("error", () => {})`) prevents Node/Bun from escalating transient filesystem errors (such as a directory vanishing during `bun install`) into unhandled exceptions that crash the main process.
- **Completeness:** **Complete.** The watcher is properly treated as best-effort.
- **New Issues/Regressions:** None.

### 3. Memory leak — Unbounded document/diagnostic caches (`client.ts` + `diagnostics.ts`)
- **Correctness:** **Correct (for opened files).** The `evictIfOverCap` method properly acts as an LRU cache. It uses the JavaScript `Map`'s insertion-order property by grabbing the oldest key via `this.openDocuments.keys().next().value`. The `change()` method successfully maintains LRU order by deleting and re-inserting documents so they move to the tail. Evicted files correctly send `textDocument/didClose` and clear their state via `this.diagnostics.purge()`.
- **Completeness:** **Incomplete.** The fix bounds the memory for files the agent explicitly opens, but misses files analyzed passively. Language servers (like `pyright`, `rust-analyzer`, or `tsserver`) often scan the workspace in the background and emit `textDocument/publishDiagnostics` for files the client never touched. These trigger `DiagnosticsStore.setPushDiagnostics()`, which caches them unconditionally in the `pushDiagnostics` map. Because these background files are never placed in `openDocuments`, they are never reached by the `evictIfOverCap` loop. As a result, the `DiagnosticsStore` will still slowly leak memory over time as background files accumulate.
- **New Issues/Regressions:** None introduced. The `closeDocument` method is carefully guarded with `wasOpen` so it doesn't send invalid `didClose` notifications for unopened files. There are no race conditions in the polling logic (`waitForDiagnostics`).

### 4. Minor — Leaked promises on initialize timeout (`rpc.ts`)
- **Correctness:** **Correct.** Passing the `timeoutMs` parameter directly into `rpc.sendRequest` (rather than wrapping it in an external `Promise.race`) successfully utilizes the connection's internal timeout handler. When the timeout triggers, `rpc.ts` explicitly deletes the request ID from the `this.pending` Map, freeing the memory.
- **Completeness:** **Complete.** The leaked closure and promise are both cleared safely.
- **New Issues/Regressions:** None.

## Remaining Concerns
1. **Unbounded `DiagnosticsStore` Map:** As detailed in Bug 3, `this.pushDiagnostics` and `this.pushReceived` inside `DiagnosticsStore` have no size bounds. A server pushing diagnostics for thousands of untouched files across a large monorepo will keep those strings and objects in memory forever until the client is destroyed.

## Recommendations
- **Bound passive diagnostics:** Modify `DiagnosticsStore` to implement its own LRU cache for `pushDiagnostics`, or have it coordinate with `client.ts` to ensure that even unopened files with diagnostics are eventually aged out and purged when a maximum threshold is reached.
