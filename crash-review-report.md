# Production Crash Investigation — Independent Review

## Executive Summary

The production Dispatch server is experiencing two distinct failure modes under load:
1. **Exit-code 1 Crashes**: Driven by an unhandled `EventEmitter` `'error'` event from the `ssh2` connection pool, **not** the AI-SDK as previously suspected.
2. **Bun Runtime Segfaults**: Triggered by massive memory pressure from unbounded conversation history serialization during long multi-step agent turns, confirming the "leak" is actually a massive live working set, not a persistent memory leak.

Additionally, a suspected latent crash path in the cache-warming probe has been confirmed as an Unhandled Promise Rejection.

---

## 1. The Exit-1 Crash ("Timed out while waiting for handshake")

### Finding: Confirmed Dispatch Bug in SSH Pool (Incorrect Preliminary Finding)
The preliminary analysis hypothesized that the `error: Timed out while waiting for handshake` crash was caused by an unhandled `'error'` on an outbound TLS socket to the AI provider. **This is incorrect.** 

The crash actually originates from the `ssh2` package managing outbound remote computer connections, specifically within `packages/ssh/src/pool.ts`.

### Technical Analysis
- **The Evidence**: The exact string `'Timed out while waiting for handshake'` is hardcoded in `ssh2/lib/client.js` when the SSH handshake times out or keepalives fail during a re-keying phase.
- **The Code Path**: In `packages/ssh/src/pool.ts`, the `doConnect` function attaches an `onError` listener to the `ssh2.Client` instance to catch connection failures:
  ```typescript
  client.on("error", onError);
  ```
  However, when the connection succeeds (`onReady` fires), the `cleanup()` function is called, which **removes the error listener**:
  ```typescript
  function cleanup(): void {
    clearTimeout(timer);
    client.removeListener("ready", onReady);
    client.removeListener("error", onError); // <-- Listener removed here
  }
  ```
- **The Crash Mechanism**: After `doConnect` succeeds, the client is placed in the pool and returned to callers. If the SSH connection drops later or a timeout occurs, the `ssh2.Client` emits an `'error'` event. Because there are no longer any listeners attached for `'error'`, Node.js's `EventEmitter` escalates it to an uncaught exception, instantly crashing the process with exit code 1.

### Recommendation
**Dispatch Code Change**: Add a persistent `.on("error", ...)` handler to the `client` in `buildConnection` (or refrain from removing it) to gracefully catch post-connection drops, tear down the connection, and transition `state.value = "error"`. 

---

## 2. The Bun Native Segfaults (The 6.2 GB "Leak")

### Finding: Massive Live Working Set, Not a Persistent Leak
The preliminary investigation suspected a 2.5 GB/hour slow leak. The telemetry data confirms that the memory is **not permanently leaked**—when `activeConversations` drops to `0`, the RSS cleanly drops back down to the ~84 MB baseline. The crash is caused by unbounded live working set growth during concurrent agent turns, which fragments and overwhelms Bun's allocator.

### Technical Analysis
- **The Code Path**: `MAX_STEPS` in `packages/kernel/src/runtime/run-turn.ts` is set to `0` (unlimited). A single turn can run for hundreds of steps.
- **The Mechanism**: In `executeStep`, every step appends new tool calls and results to the `messages` array. This array is then passed to `provider.stream()`.
- Inside `packages/openai-stream/src/stream.ts`, the entire unbounded array is serialized into a single contiguous string every step:
  ```typescript
  const bodyString = JSON.stringify(body);
  ```
- **The Crash**: If 4 concurrent conversations (`activeConversations = 4`) run for hundreds of steps, the `messages` arrays grow to hundreds of megabytes each. Serializing these arrays copies them into massive contiguous strings on the V8 heap on *every step*. This causes gigabytes of memory allocation churn, memory pressure spikes (peaking at 6.2 GB), and eventually triggers a native `SIGSEGV`/`SIGILL` in Bun's allocator.

### Recommendation
**Dispatch Code Change**: 
1. Reintroduce a sane `MAX_STEPS` limit (e.g., `50` or `100`) to bound the maximum length of a single turn.
2. Implement a sliding window or context-truncation strategy for `messages` before serializing to prevent the payload from growing infinitely.
3. **Operational Mitigation**: Apply the `MemoryMax` cgroup circuit breaker to turn the segfault into a controlled recycle while the codebase fix is developed.

---

## 3. The Cache-Warming Latent Crash

### Finding: Confirmed Latent Unhandled Promise Rejection
The preliminary finding suspected a latent crash path due to a missing `try/catch` in the cache-warming probe. This is confirmed.

### Technical Analysis
- **The Code Path**: In `packages/session-orchestrator/src/orchestrator.ts`, the `createWarmService`'s `warm` function consumes the provider stream:
  ```typescript
  for await (const event of provider.stream(messages, assembled.tools, providerOpts)) {
  ```
- **The Mechanism**: If the AI provider connection fails or aborts, `provider.stream` throws. Because there is no `try/catch` around this loop, the async `warm` function rejects its returned promise.
- In `packages/cache-warming/src/warmer.ts`, the timer fires `void fireWarm(conversationId, token);`. Since the returned promise is not `await`ed or `.catch()`'d at the top level, it results in an **Unhandled Promise Rejection**.

### Recommendation
**Dispatch Code Change**: Add a `try/catch` block around the `for await` loop in `createWarmService` (or add `.catch()` to `fireWarm`) to gracefully emit an error result instead of throwing an unhandled rejection.

---

## Assessment of Preliminary Findings

- ❌ **"Unhandled TLS Socket to AI Provider"**: Incorrect. The exit-1 crash was a race condition in error listener attachment for outbound SSH connections (`ssh2`), not the AI SDK's TLS socket.
- ✅ **"MAX_STEPS = 0 ... structural enabler for large working sets"**: Correct. Unbounded history serialization caused the massive gigabyte allocations that crashed Bun.
- ✅ **"Cache-warming missing try/catch"**: Correct. It is an unhandled promise rejection waiting to happen.
- ✅ **"Not an LSP leak"**: Confirmed. The memory growth is strictly tied to `activeConversations` and the unbounded turn array serialization.
