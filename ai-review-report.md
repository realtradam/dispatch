# LSP Subsystem Review

## Executive Summary

The production `dispatch.service` is destabilizing due to three distinct issues in the LSP subsystem:
1. **Crash Type 1 (The "Defence-in-Depth" TypeError):** The original `SyntaxError` from malformed JSON has been mitigated by a `try/catch` in `rpc.ts`, but the subsequent "defence-in-depth" boundary added in `client.ts` introduced a fatal `TypeError` via improper optional chaining.
2. **Crash Type 2 (Unhandled Watcher ENOENT):** The recursive `node:fs` watcher (`extension.ts`) throws an uncaught exception when it encounters deleted transient files (e.g., during `bun install`).
3. **Severe Memory Leak (Unbounded Caches):** The `LanguageServerClient` retains the full text and diagnostics of every file it ever interacts with in memory indefinitely. When an AI agent scans many files, this memory footprint grows linearly, causing the 9.5 GB usage spike.

---

## Root Causes & Detailed Technical Analysis

### 1. Crash Type 1: Unhandled JSON Parse / TypeError (`client.ts`)

**Location:** `packages/lsp/src/client.ts`, line 278

```typescript
// Current Code
void this.rpc?.handleMessage(msg).catch(() => {});
```

**The Bug:** The stack trace in the journal logs (`at handleMessage ... at handleBytes`) points to an error in the byte stream handler. While the developer correctly added a `try/catch` inside `rpc.ts` to prevent malformed JSON from crashing the app, they introduced a fatal flaw in `client.ts` when trying to suppress unhandled promise rejections.

In JavaScript, optional chaining (`?.`) short-circuits the evaluation of the entire expression if the left-hand side is null/undefined. When the server process dies, `handleExit` sets `this.rpc = null`. If standard output flushes a final chunk *after* this occurs, `this.rpc?.handleMessage(msg)` evaluates to `undefined`. Appending `.catch(() => {})` to this results in `undefined.catch()`, which throws a synchronous `TypeError: Cannot read properties of undefined (reading 'catch')`. This exception is entirely unhandled and bypasses all safeguards, crashing the Bun process.

**Recommendation:**
Properly chain the `.catch` statement using optional chaining, or use a traditional `if` block:
```typescript
// Fix option 1:
void this.rpc?.handleMessage(msg)?.catch(() => {});

// Fix option 2:
if (this.rpc) {
  void this.rpc.handleMessage(msg).catch(() => {});
}
```

### 2. Crash Type 2: Unhandled ENOENT from File Watcher (`extension.ts`)

**Location:** `packages/lsp/src/extension.ts`, lines 63-68

```typescript
// Current Code
const watcher = watch(root, { recursive: true }, (eventType: string, filename: string | null) => {
    // ...
});
return { close: () => watcher.close() };
```

**The Bug:** Node's native `fs.watch` backend natively emits `'error'` events when it loses track of files—such as when watching a directory that is rapidly deleted (e.g., transient `.old_modules` directories during `bun install`). Since the returned `FSWatcher` instance does not have an `.on("error", ...)` event listener attached, Node/Bun escalates the emitted `'error'` event into an Uncaught Exception in the main event loop, abruptly killing the process.

**Recommendation:**
Attach a no-op error listener to the watcher to prevent the event loop from panicking.
```typescript
const watcher = watch(root, { recursive: true }, (eventType: string, filename: string | null) => {
    // ...
});
watcher.on("error", () => {
    // Gracefully ignore transient FS errors
});
return { close: () => watcher.close() };
```

### 3. The 9.5 GB Memory Leak (`client.ts` & `diagnostics.ts`)

**Location:** `packages/lsp/src/client.ts` and `packages/lsp/src/diagnostics.ts`

```typescript
// client.ts
private openDocuments = new Map<string, { version: number; text: string }>();
private lastDiagSnapshot = new Map<string, { keys: Set<string>; text: string }>();

// diagnostics.ts
private pushDiagnostics = new Map<string, readonly Diagnostic[]>();
```

**The Bug:** The design of `LanguageServerClient` is strictly append-only. When an agent opens a file or queries diagnostics (`waitForDiagnostics`), the full string contents of the file are loaded and stored in `openDocuments` and `lastDiagSnapshot`. 

Because there is no `.close()` method implemented, no eviction policy (e.g., LRU cache), and no code that issues a `textDocument/didClose` notification, these `Map` instances hold references to every file touched throughout the server's lifespan. Over a 12-hour session where an agent iteratively scans thousands of files across a large monorepo, these caches balloon uncontrollably, resulting in the observed 9.5 GB memory footprint.

**Recommendation:**
- Implement a document lifecycle strategy. When an agent is done with a file (or when an LRU threshold is reached), invoke a new `closeDocument` method that:
  1. Sends a `textDocument/didClose` notification to the language server.
  2. Deletes the corresponding entry from `openDocuments` and `lastDiagSnapshot`.
  3. Commands the `DiagnosticsStore` to purge the related `pushDiagnostics`.

### Minor: Leaking Promises on Initialize Timeout (`rpc.ts`)

**Location:** `packages/lsp/src/rpc.ts` (line 49) & `packages/lsp/src/client.ts` (line 356)

When `initialize` executes, it wraps `rpc.sendRequest("initialize")` in a `Promise.race` with a 45-second timeout. If the server times out, the `initialize` method rejects, but the original promise inside `this.pending` inside `rpc.ts` is never cleared. It will leak (along with its closure) in the `Map` forever. While minor compared to the document cache leak, it should be addressed by allowing `timeoutMs` to be passed into the initial `sendRequest` call directly instead of relying on `Promise.race`.
