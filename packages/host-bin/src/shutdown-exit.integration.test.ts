/**
 * End-to-end exit-code test — the wire, not just the decision.
 *
 * The unit tests in shutdown-controller.test.ts prove the DECISION logic with
 * injected fakes. This spawns a REAL Bun child process that wires the real
 * controller to the real process events and `process.exit`, then asserts the
 * OS-visible exit code — exactly what systemd's `Restart=on-failure` acts on.
 * (Not a `*.bun.test.ts`: it runs under vitest like the rest of the suite,
 * because the child is a separate real process either way.)
 *
 * The child script mirrors main.ts's wiring: SIGINT/SIGTERM → clean code,
 * uncaughtException → non-zero, unref'd deadline timer → forced non-zero.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SHUTDOWN_DEADLINE_MS, EXIT_CODES } from "./shutdown-controller.js";

const CHILD_TIMEOUT_MS = 15_000;

/** The Bun binary running this suite (falls back to PATH lookup). */
const BUN_BIN = process.execPath.includes("bun") ? process.execPath : "bun";

/** Absolute file URL of the module under test, importable by the child. */
const CONTROLLER_URL = pathToFileURL(
  path.resolve(process.cwd(), "packages/host-bin/src/shutdown-controller.ts"),
).href;

const CHILD_SOURCE = `
import { createShutdownController } from ${JSON.stringify(CONTROLLER_URL)};

const mode = process.argv[2];

// Same wiring as main.ts: a bounded, best-effort cleanup whose failure modes
// are the point of the test.
const controller = createShutdownController({
  cleanup: () => {
    console.log("cleanup-ran");
    if (mode === "hang" || mode === "hang-idle") return new Promise(() => {}); // never settles
    if (mode === "escalate") return new Promise((resolve) => setTimeout(resolve, 20));
    if (mode === "cleanup-throws") throw new Error("cleanup blew up");
    return undefined;
  },
  exit: (code) => process.exit(code),
  setTimer: (deadlineMs, onDeadline) => {
    const timer = setTimeout(onDeadline, deadlineMs); // kept ref'd, like main.ts
    return { cancel: () => clearTimeout(timer) };
  },
  deadlineMs: 100,
});

process.on("SIGINT", () => void controller.shutdown("SIGINT"));
process.on("SIGTERM", () => void controller.shutdown("SIGTERM"));
process.on("uncaughtException", () => void controller.shutdown("uncaughtException"));

console.log("ready");
if (mode === "crash" || mode === "cleanup-throws" || mode === "hang-idle") {
  setTimeout(() => { throw new Error("boom"); }, 0);
}
if (mode === "wait" || mode === "hang" || mode === "escalate") {
  setInterval(() => {}, 1000); // stay alive until a signal arrives
}
if (mode === "escalate") {
  // SIGTERM starts a shutdown whose cleanup is still running when a crash
  // lands: the final exit must be the crash code, not the SIGTERM code.
  process.on("SIGTERM", () => {
    setTimeout(() => { throw new Error("boom during shutdown"); }, 0);
  });
}
`;

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
}

let dir: string;
let scriptPath: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dispatch-shutdown-exit-"));
  scriptPath = path.join(dir, "child.ts");
  await writeFile(scriptPath, CHILD_SOURCE);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Spawn the child. With `signal`, wait for its "ready" line first so the
 * handlers are definitely installed, then deliver a real OS signal.
 */
async function runChild(mode: string, signal?: NodeJS.Signals): Promise<ChildResult> {
  const child = spawn(BUN_BIN, [scriptPath, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.resume(); // drain; the child may print an uncaught-exception trace

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, sig) => resolve({ code, signal: sig }));
  });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child (${mode}) did not exit within ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS).unref();
  });

  if (signal !== undefined) {
    const deadline = Date.now() + CHILD_TIMEOUT_MS;
    while (!stdout.includes("ready")) {
      if (Date.now() > deadline) throw new Error(`child (${mode}) never became ready`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill(signal);
  }

  const result = await Promise.race([exited, timeout]);
  return { ...result, stdout };
}

describe("server process exit codes (real Bun child)", () => {
  it(
    "exits 0 on SIGTERM (intentional stop is NOT restarted by systemd)",
    async () => {
      const result = await runChild("wait", "SIGTERM");

      expect(result.stdout).toContain("cleanup-ran");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(EXIT_CODES.clean);
      expect(result.code).toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it(
    "exits non-zero on an uncaught exception (so Restart=on-failure fires)",
    async () => {
      const result = await runChild("crash");

      expect(result.stdout).toContain("cleanup-ran");
      expect(result.code).toBe(EXIT_CODES.crash);
      expect(result.code).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it(
    "exits non-zero when cleanup throws",
    async () => {
      const result = await runChild("cleanup-throws");

      expect(result.code).toBe(EXIT_CODES.crash);
      expect(result.code).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it(
    "force-exits non-zero when cleanup hangs (never stays alive but broken)",
    async () => {
      const result = await runChild("hang", "SIGTERM");

      // It reached shutdown and hung in cleanup; the deadline forced the exit.
      expect(result.stdout).toContain("cleanup-ran");
      expect(result.code).toBe(EXIT_CODES.deadlineExceeded);
      expect(result.code).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it(
    "force-exits non-zero when a hung cleanup leaves the event loop idle",
    async () => {
      // Nothing else is ref'd in this mode: without a REF'D deadline timer Bun
      // would exit on its own (code 0 → no systemd restart). The deadline must
      // hold the loop open and exit 70.
      const result = await runChild("hang-idle");

      expect(result.stdout).toContain("cleanup-ran");
      expect(result.code).toBe(EXIT_CODES.deadlineExceeded);
      expect(result.code).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it(
    "exits non-zero when a crash lands during an in-progress SIGTERM shutdown",
    async () => {
      const result = await runChild("escalate", "SIGTERM");

      expect(result.stdout).toContain("cleanup-ran");
      expect(result.code).toBe(EXIT_CODES.crash);
      expect(result.code).not.toBe(0);
    },
    CHILD_TIMEOUT_MS + 5_000,
  );

  it("keeps the production deadline comfortably under systemd's 90s stop timeout", () => {
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBe(10_000);
    expect(DEFAULT_SHUTDOWN_DEADLINE_MS).toBeLessThan(90_000);
  });
});
