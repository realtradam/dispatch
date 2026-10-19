# Plan — A crashed server must exit non-zero (and never hang) so systemd restarts it

Status: approved by user, ready to implement
Branch: `feature/host-crash-restart`
Package: `packages/host-bin` (core). No other package.

---

## 1. Problem

Production runs `/usr/bin/dispatch-server` under systemd with
`Restart=on-failure` / `RestartSec=5` (`systemd/dispatch.service`).
`on-failure` restarts only on a **non-zero exit, a signal, or a timeout** — a
clean exit 0 is treated as an intentional stop and is **not** restarted.

`packages/host-bin/src/main.ts` (~L393–435):

```ts
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  memoryTelemetry?.stop();
  await host.deactivate();
  await supervisor?.stop();
  process.exit(0);            // ← always 0
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
...
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", { ... });
  void shutdown();            // ← crash path reuses the clean path → exit 0
});
```

Consequences:
1. **Any uncaught exception → exit code 0 → systemd does not restart.**
   Dispatch stays down until someone restarts it by hand.
2. **The crash path can hang forever.** If `host.deactivate()` or
   `supervisor.stop()` throws or never settles (plausible right after an
   uncaught exception, when state may be corrupt), `process.exit` is never
   reached. The process stays alive but broken, and systemd sees it as running
   → no restart at all.
3. If an uncaught exception happens while a SIGTERM shutdown is already in
   progress, `shutdown()` returns early and the crash is effectively swallowed
   (exit code still 0 if the clean shutdown completes).

## 2. Required behavior

- **SIGINT / SIGTERM** (intentional stop: `systemctl stop`, Ctrl-C in dev):
  graceful shutdown as today, exit **0**.
- **uncaughtException**: log as today, attempt the same graceful cleanup, then
  exit with a **non-zero** code (e.g. 1) so `Restart=on-failure` restarts it.
- **Bounded shutdown**: cleanup is best-effort and time-boxed. If cleanup
  throws, still exit. If it doesn't finish within a deadline (pick a sensible
  value, e.g. ~10 s, and keep it well under systemd's default stop timeout of
  90 s), force-exit. A forced exit after a crash is non-zero; a forced exit
  during a SIGTERM shutdown should also be non-zero (it didn't shut down
  cleanly) — justify your choice.
- **Crash during an in-progress shutdown**: must still end with a non-zero exit
  (don't let the early-return swallow it).
- A second uncaught exception thrown *during* crash cleanup must not prevent the
  exit.
- **unhandledRejection**: keep today's behavior (log only, keep running) —
  out of scope; do not change it.
- **Boot failure**: `boot().catch(...)` already exits 1 for the dev entry
  point. Check the compiled-binary entry (the build wrapper that calls `boot()`
  itself with preloaded extensions — find it) and make sure a fatal boot error
  there also exits non-zero.

## 3. Design notes (AGENTS.md: decision logic pure, effects injected)
- Put the decision logic (which exit code for which trigger; "already shutting
  down + crash" handling; deadline handling) in a small pure/injectable unit,
  e.g. a `createShutdownController({ cleanup, exit, setTimer, logger })` in its
  own module, and wire `main.ts` to it. `process.exit`, timers and the cleanup
  steps are injected so it's unit-testable without killing the test runner.
- Make sure the deadline timer doesn't keep a healthy process alive on its own
  (unref it, or only arm it once shutdown has started).
- Keep the existing log lines (`uncaughtException` with memory snapshot etc.).

## 4. Out of scope
- `systemd/dispatch.service` — keep `Restart=on-failure` (with non-zero crash
  exits it now does the right thing, and an intentional `systemctl stop` still
  won't be restarted). Mention in the report if you think it should change.
- unhandledRejection policy, memory telemetry, anything outside host-bin.
- SSH code.

## 5. Tests
Unit tests for the controller with injected fakes:
- SIGTERM → cleanup runs → exit(0).
- uncaughtException → cleanup runs → exit(non-zero).
- cleanup throws → still exits (code per trigger).
- cleanup never settles → forced exit at the deadline (non-zero).
- uncaughtException while a SIGTERM shutdown is in progress → final exit is non-zero.
- repeated signals / repeated exceptions → cleanup runs once, exactly one exit.
Optional but valuable: a Bun-run integration test (`*.bun.test.ts`, see the
existing `bundled.bun.test.ts` pattern) that spawns a tiny script using the real
controller, throws an uncaught exception, and asserts the child's exit code is
non-zero; and one that sends SIGTERM and asserts 0.

## 6. Verification gate
`bun install`, `bun run typecheck`, `bun run test`, `bun run test:bun`,
`bun run check` — all green. Commit to `feature/host-crash-restart` only. Do not
merge or push. Write the report per AGENTS.md "Reports".
