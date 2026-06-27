# Concurrency Library Investigation

> Research-only. No code changes. Investigated 2026-06-26.

## 1. ai-concurrency-shaper (joeycumines)

**Repository:** https://github.com/joeycumines/ai-concurrency-shaper

### What it is
A **standalone reverse proxy** written in **Go**. It sits between your
application and an upstream AI/LLM API (e.g. Anthropic, OpenAI), limiting
concurrent requests to configured HTTP routes. Requests exceeding the limit
block until a slot opens. Non-matching requests pass through unmodified.

### How it works
- Uses a **token-bucket channel** (Go's `chan struct{}`) as a semaphore. Each
  limited request acquires a token; the token is returned when the request
  completes (full response body streamed).
- Supports **per-route** concurrency limits via `-limit "POST /v1/chat/completions:4"`
  and **global** concurrency via `-global-concurrency 10`.
- Supports **route grouping** — multiple routes can share one limiter via
  `@group` syntax.
- Has a **circuit breaker** (trips after N failures in a window, exponential
  backoff with phantom concurrency holds).
- Has **concurrency protection flags**: release cooldown, cancel cooldown,
  failure hold, adaptive headroom (reduce effective limit by 1 after a 429).
- **429 handling**: skips retrying 429s by default (`-retry-skip-429=true`).
- Optional **TUI dashboard** (Bubble Tea) with live metrics.
- **In-memory only** — no persistence, no external state (single process).

### Maturity
- **1 star, 1 fork, 7 commits**, created June 10, 2026 (16 days ago).
- **Single contributor** (Joseph Cumines).
- **GPL-3.0 license** (copyleft — incompatible with closed-source distribution).
- Written in **Go**, not JavaScript/TypeScript.

### Critical finding: language mismatch
This is a **Go binary**, not an npm library. It cannot be imported into a
Bun/TypeScript application. To use it, we would need to:
1. Run it as a **separate process** (a sidecar proxy).
2. Point our provider's `baseURL` at the proxy's listen address.
3. The proxy forwards to the real upstream.

This fundamentally changes our architecture from "in-process concurrency
management" to "external proxy-based concurrency management."

### Feature comparison vs our implementation

| Feature | Our impl | ai-concurrency-shaper |
|---|---|---|
| Per-provider configurable limits | ✅ (runtime API + in-memory) | ✅ (per-route CLI flags, not runtime) |
| Oldest-agent-first scheduling | ✅ (priority queue by promptStartedAt) | ❌ (FIFO semaphore, no priority) |
| Slot held only during token generation | ✅ (acquire/release around stream) | ✅ (token held until response body completes) |
| 429 backoff | ✅ (pause queue, Retry-After aware) | ✅ (circuit breaker + adaptive headroom) |
| Watchdog/deadlock recovery | ✅ (timeout-based slot reclaim) | ❌ (no watchdog; relies on queue-timeout) |
| Runtime-configurable limits | ✅ (HTTP API, no restart) | ❌ (CLI flags only, requires restart) |
| In-memory / no external state | ✅ | ✅ |
| Language | TypeScript (Bun) | Go |
| Integration model | In-process (wraps ProviderContract) | External proxy (separate process) |
| Status reporting API | ✅ (HTTP endpoints) | TUI only (no HTTP API) |
| License | Our code (MIT-style) | GPL-3.0 |

### What would change to use it
1. Deploy the Go binary as a sidecar process.
2. Change each provider's `baseURL` to point at the proxy.
3. Lose runtime-configurable limits (CLI flags only).
4. Lose oldest-agent-first scheduling (FIFO only).
5. Lose the in-process status API (TUI only, no HTTP).
6. Add a process management dependency (start/stop/monitor the proxy).
7. Accept GPL-3.0 license implications.

## 2. Drawbacks of using ai-concurrency-shaper

### Fatal drawbacks
1. **No oldest-agent-first scheduling.** Our implementation prioritizes the
   agent whose prompt started longest ago. The proxy uses a simple FIFO
   semaphore — no priority queue. This is a core requirement.
2. **No runtime-configurable limits.** Limits are set via CLI flags at startup.
   Our frontend has a settings UI to add/remove/update limits at runtime.
3. **Language mismatch.** It's a Go binary, not an npm package. We'd need to
   run it as a separate process, adding operational complexity.
4. **No HTTP status API.** The proxy exposes status only via TUI. Our frontend
   polls `GET /concurrency/status` for live in-flight/queued/paused state.
5. **GPL-3.0 license.** Copyleft — may be incompatible with our distribution
   model.

### Secondary drawbacks
6. **No watchdog.** If a slot holder dies (e.g. the proxy's connection to the
   client drops but the upstream request is still in flight), there's no
   timeout-based reclaim. It relies on `-queue-timeout` for queue wait, not
   for held slots.
7. **Immature.** 1 star, 7 commits, 16 days old, single contributor. No
   community, no battle-testing.
8. **No provider-awareness.** It limits by HTTP route pattern, not by
   "provider." Our implementation is keyed on `providerId` (e.g. "umans",
   "openai-compat"), which maps naturally to our `ProviderContract.id`.
9. **Operational overhead.** Running a separate Go process alongside the Bun
   app adds deployment complexity, monitoring burden, and a failure mode
   (proxy down = all requests fail).

## 3. Other libraries/tools for AI API concurrency

### p-queue (sindresorhus)
- **npm**, TypeScript, MIT, 4.2k stars, 727k dependents.
- General-purpose promise queue with concurrency control.
- Supports **priority** (`{priority: number}` per task), **rate limiting**
  (`intervalCap` + `interval`), **pause/resume**, **timeouts**, **custom
  queue class** (for custom scheduling), AbortSignal cancellation.
- **No AI-specific logic** — no 429 detection, no provider concept, no
  streaming-awareness.
- Could be used as a **building block** to replace our queue implementation,
  but we'd still need the provider wrapper, 429 detection, watchdog, and
  status API on top.
- **Feature complete** (maintainer says no further development planned, but
  accepts PRs).

### p-limit (sindresorhus)
- **npm**, TypeScript, MIT, 5.4k dependents.
- Simpler than p-queue — just limits concurrent executions. No queue, no
  priority, no pause. Not suitable for our use case (we need queuing).

### ai-sdk-rate-limiter (piyushgupta344)
- **npm**, TypeScript, zero dependencies.
- Designed for the Vercel AI SDK (`@ai-sdk/*`). Wraps model objects.
- Has **priority queuing** (high/normal/low lanes), **429 backoff with
  Retry-After**, **cost tracking & budget enforcement**, **multi-tenant
  scopes**, **Redis for multi-instance**, **observability** (Prometheus,
  OpenTelemetry).
- Built-in limits for OpenAI, Anthropic, Google, Groq, Mistral, Cohere.
- **Closest to our use case** of any npm library found.
- **Maturity unknown** — couldn't verify star count or maintenance activity
  from the docs site. Appears to be a solo project.
- **Concerns**: It's designed for the Vercel AI SDK's model-wrapping pattern.
  Our provider architecture uses `ProviderContract.stream()` returning an
  `AsyncIterable<ProviderEvent>`, not the Vercel AI SDK's model interface.
  We'd need an adapter. It also doesn't expose a status API for the frontend.

### LiteLLM (BerriAI)
- **Python**, MIT, 51.7k GitHub stars, very mature (39k+ commits).
- Full **LLM gateway/proxy** — not a library. Runs as a separate server.
- Has `enforce_model_rate_limits` for RPM/TPM hard limits.
- Supports **least-busy routing**, **latency-based routing**, **cost-based
  routing**, **fallbacks**, **deployment priority**.
- **No concurrency limiting** — it limits requests-per-minute (RPM) and
  tokens-per-minute (TPM), not concurrent in-flight requests. RPM is a rate
  limit, not a concurrency limit. An agent that sends 4 requests in 1 second
  and then waits would be blocked by RPM=60 but not by concurrency=4.
- Would require running a Python proxy server alongside our Bun app.
- Overkill for our use case — it's a full LLM gateway with virtual keys, cost
  tracking, guardrails, etc.

### Portkey AI Gateway
- **Hosted/self-hosted**, open-source (Apache-2.0).
- Full AI gateway with routing, fallbacks, caching, observability.
- Rate limiting is **Enterprise-only** and per-team/per-key, not per-provider
  concurrency.
- Same architectural model as LiteLLM (external proxy).

### Kong AI Gateway
- Built on Kong's API gateway. Enterprise-focused.
- Rate limiting is plugin-based (RPM/TPM), not concurrency-based.
- Same external-proxy model.

## 4. Recommendation

### **Keep the custom implementation. Do not switch to a library.**

### Rationale

1. **No library matches our requirements.** The core differentiators of our
   implementation — **oldest-agent-first scheduling**, **runtime-configurable
   per-provider limits**, **in-process status API**, and **stream-aware slot
   lifecycle** — are not found in any library or proxy we investigated:
   - `ai-concurrency-shaper` is a Go proxy with FIFO, no priority, no runtime
     config, no HTTP status API, and GPL-3.0.
   - `p-queue` has priority but no AI-specific logic, no 429 detection, no
     streaming-awareness, no status API.
   - `ai-sdk-rate-limiter` is close but designed for the Vercel AI SDK's model
     interface, not our `ProviderContract.stream()` pattern.
   - LiteLLM/Portkey/Kong are full gateway proxies with RPM/TPM rate limiting,
     not concurrency limiting, and require running a separate server.

2. **Our implementation is small and well-tested.** The core
   `concurrency-manager.ts` is ~280 lines of pure logic with 15 tests and
   injected timers. The `provider-wrapper.ts` is ~70 lines with 6 tests. The
   total surface is tiny — there's no maintenance burden to justify
   offloading to a library.

3. **The architecture is a perfect fit.** Our `ProviderContract` wrapping
   pattern (acquire before stream, release after stream) is the cleanest
   possible integration point. An external proxy would add a network hop,
   a process to manage, and break the direct relationship between the
   orchestrator and the provider.

4. **Oldest-agent-first scheduling is a hard requirement.** No library or
   proxy we found supports priority queuing by turn-start time. This is the
   core value proposition of our implementation — older agents complete
   sooner, reducing overall wait time.

5. **Runtime configurability is a hard requirement.** The frontend has a
   settings UI for adding/removing/updating limits without restart. No
   library supports this — they all require static configuration.

### What we would lose by switching
- Oldest-agent-first scheduling (no library supports it).
- Runtime-configurable limits (no library supports it).
- In-process status API (no library supports it).
- Direct integration with `ProviderContract` (would need adapter or proxy).
- ~280 lines of well-tested code that we own and control.

### What we would gain by switching
- Nothing we don't already have. The features libraries offer (circuit
  breakers, adaptive headroom, TUI dashboards) are either already in our
  implementation (429 backoff, watchdog) or not needed (TUI — we have a web
  frontend).

### When to reconsider
- If we need **multi-instance** concurrency coordination (multiple app
  processes sharing limits), we would need Redis-backed state. At that point,
  `ai-sdk-rate-limiter` (which has a Redis store) or a custom Redis-backed
  extension of our current implementation would be worth evaluating.
- If we need **RPM/TPM rate limiting** (not just concurrency), LiteLLM or
  Portkey could complement our concurrency limits. But these are orthogonal
  concerns — RPM limits total requests per minute, while concurrency limits
  in-flight requests at any moment.
- If `ai-sdk-rate-limiter` matures and adds a status API + custom model
  adapters, it could be worth re-evaluating as a replacement for the queue
  layer (while keeping our provider wrapper + status API).
