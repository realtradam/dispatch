/**
 * scripts/verify-lsp-diagnostics.ts — REAL-SERVER verification of the async
 * diagnostics client (`packages/lsp/src/client.ts`).
 *
 * Why this exists: `typescript-language-server` does not advertise
 * `publishDiagnostics.versionSupport`; it sends MULTIPLE pushes per sync with
 * no version, and on a COLD server the first push can arrive ~2.4 s after
 * `didOpen`, followed by more over the next ~200 ms. The client's unversioned
 * "quiet window + deferred didChange" protocol must guarantee that an edit's
 * result describes the EDIT's content, never the previous generation's late
 * burst. Unit tests use fake servers; this script proves it against the real
 * binary.
 *
 * Each RUN spawns a FRESH language server and a fresh temp workspace. Each
 * ROUND does open(clean) → edit(type error) → edit(fix) back-to-back (the next
 * call starts as soon as the previous one returns, as an edit tool would) and
 * asserts ERROR → clean. Round 0 of every run is therefore the cold-start
 * case that used to lag one version behind.
 *
 * Usage (from the backend repo root):
 *
 *   bun scripts/verify-lsp-diagnostics.ts                       # TypeScript
 *   LSP_VERIFY_SERVER=biome bun scripts/verify-lsp-diagnostics.ts  # Biome
 *
 * Env overrides:
 *   LSP_VERIFY_SERVER      "typescript" (default) | "biome"
 *   TS_LSP_BIN             path to typescript-language-server (default:
 *                          /home/PII_REDACTED_USER_01/.local/bin/typescript-language-server)
 *   BIOME_BIN              path to the biome binary (default:
 *                          <repo>/node_modules/.bin/biome)
 *   LSP_VERIFY_RUNS        fresh-server runs (default 3)
 *   LSP_VERIFY_ROUNDS      rounds per run (default 3; round 0 is cold)
 *   LSP_VERIFY_SETTLE_MS   override the client's unversioned quiet window
 *
 * Exit code 0 = every round reported the right content's diagnostics.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanguageServerClient, type SpawnedProcess } from "../packages/lsp/src/client.js";

const TS_BIN = process.env.TS_LSP_BIN ?? "/home/PII_REDACTED_USER_01/.local/bin/typescript-language-server";
const BIOME_BIN = process.env.BIOME_BIN ?? join(import.meta.dir, "..", "node_modules/.bin/biome");
const SERVER = process.env.LSP_VERIFY_SERVER ?? "typescript";
const RUNS = Number(process.env.LSP_VERIFY_RUNS ?? 3);
const ROUNDS = Number(process.env.LSP_VERIFY_ROUNDS ?? 3);
const SETTLE_MS =
  process.env.LSP_VERIFY_SETTLE_MS !== undefined
    ? Number(process.env.LSP_VERIFY_SETTLE_MS)
    : undefined;
const WAIT_TIMEOUT_MS = 30_000;

interface ServerSpec {
  readonly label: string;
  readonly command: readonly string[];
  readonly serverId: string;
  /** Clean content, unique per round so every sync is a genuine change. */
  readonly clean: (n: number) => string;
  /** Content the server must flag with at least one ERROR. */
  readonly broken: (n: number) => string;
}

const SERVER_SPEC: ServerSpec =
  SERVER === "biome"
    ? {
        label: "biome (VERSIONED publishes)",
        command: [BIOME_BIN, "lsp-proxy"],
        serverId: "biome",
        clean: (n) => `export const value: number = ${n};\n`,
        // `noDebugger` is a recommended Biome rule → ERROR severity.
        broken: (n) => `debugger;\nexport const value: number = ${n};\n`,
      }
    : {
        label: "typescript-language-server (UNVERSIONED publishes)",
        command: [TS_BIN, "--stdio"],
        serverId: "typescript",
        // TS2322: Type 'string' is not assignable to type 'number'.
        clean: (n) => `export const value: number = ${n};\n`,
        broken: (n) => `export const value: number = "not a number ${n}";\n`,
      };

const cleanFor = (round: number): string => SERVER_SPEC.clean(round + 1);
const brokenFor = (round: number): string => SERVER_SPEC.broken(round + 1);

function realSpawn(
  command: string[],
  opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
): SpawnedProcess {
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.env) {
    for (const [key, value] of Object.entries(opts.env)) env[key] = value;
  }
  const proc = Bun.spawn(command, {
    cwd: opts.cwd,
    env: env as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    pid: proc.pid,
    kill: () => proc.kill(),
    onExit: (handler) => {
      (proc as { exited: Promise<number | null> }).exited
        .then((code) => handler({ code }))
        .catch(() => handler({ code: null }));
    },
  };
}

const noopFileWatcher = () => ({ close: () => {} });

const fs = {
  readText: async (path: string) => Bun.file(path).text(),
  exists: async (path: string) => Bun.file(path).exists(),
};

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "lsp-verify-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );
  return dir;
}

function hasError(formatted: string): boolean {
  return /\bERROR\b/.test(formatted);
}

function firstIssueLine(formatted: string): string {
  return formatted.split("\n")[0] ?? "";
}

interface RoundResult {
  readonly run: number;
  readonly round: number;
  readonly cold: boolean;
  readonly openMs: number;
  readonly brokenMs: number;
  readonly fixedMs: number;
  readonly brokenFormatted: string;
  readonly fixedFormatted: string;
  readonly openClean: boolean;
  readonly brokenErrors: boolean;
  readonly fixedClean: boolean;
  /** A timeout is ALWAYS a failure — an empty "clean" result is not enough. */
  readonly timedOut: boolean;
}

const results: RoundResult[] = [];
let failures = 0;

for (let run = 0; run < RUNS; run++) {
  const dir = makeWorkspace();
  const file = join(dir, "src", "a.ts");
  writeFileSync(file, cleanFor(0));

  const client = new LanguageServerClient({
    spawn: realSpawn,
    fileWatcher: noopFileWatcher,
    fs,
    command: [...SERVER_SPEC.command],
    root: dir,
    serverId: SERVER_SPEC.serverId,
    ...(SETTLE_MS !== undefined ? { unversionedSettleMs: SETTLE_MS } : {}),
  });

  try {
    await client.start();
    if (client.getState() !== "connected") {
      throw new Error(`server did not connect: ${client.getStateError() ?? "unknown"}`);
    }

    for (let round = 0; round < ROUNDS; round++) {
      const clean = cleanFor(round);
      const broken = brokenFor(round);

      // Round 0 additionally runs the MID-BURST scenario first: the edit is
      // issued the instant the server's FIRST open push arrives, exactly like
      // the reported trace (`didOpen`, push at +2.4 s, `didChange` 7 ms later).
      // The client must defer the change until the burst quiesces.
      if (round === 0) {
        const midBurstClean = cleanFor(100);
        const midBurstBroken = brokenFor(100);
        const firstPush = new Promise<void>((resolve) => {
          const handle = client.getDiagnosticsStore().addPushWaiter(`file://${file}`, (outcome) => {
            if (outcome.kind === "push") {
              handle.cancel();
              resolve();
            }
          });
          setTimeout(resolve, WAIT_TIMEOUT_MS); // never hang the script
        });

        const tOpenMid = Date.now();
        const openMid = client.waitForDiagnostics(file, {
          text: midBurstClean,
          timeoutMs: WAIT_TIMEOUT_MS,
          minSeverity: 2,
        });
        await firstPush;
        // Mid-burst edit: issued 0 ms after the first push, NOT after the open
        // returned (this is the case that used to accept a stale burst).
        const tBrokenMid = Date.now();
        const brokenMid = client.waitForDiagnostics(file, {
          text: midBurstBroken,
          timeoutMs: WAIT_TIMEOUT_MS,
          minSeverity: 2,
        });
        const openMidResult = await openMid;
        const openMidMs = Date.now() - tOpenMid;
        const brokenMidResult = await brokenMid;
        const brokenMidMs = Date.now() - tBrokenMid;
        const tFixedMid = Date.now();
        const fixedMid = await client.waitForDiagnostics(file, {
          text: midBurstClean,
          timeoutMs: WAIT_TIMEOUT_MS,
          minSeverity: 2,
        });
        const fixedMidMs = Date.now() - tFixedMid;

        const midOk =
          !openMidResult.timedOut &&
          !brokenMidResult.timedOut &&
          !fixedMid.timedOut &&
          !hasError(openMidResult.formatted) &&
          hasError(brokenMidResult.formatted) &&
          !hasError(fixedMid.formatted);
        if (!midOk) failures += 1;
        console.log(
          `${midOk ? "PASS" : "FAIL"} run ${run} MID-BURST edit ${run === 0 ? "(cold)" : ""} ` +
            `open=${openMidMs}ms broken=${brokenMidMs}ms fix=${fixedMidMs}ms ` +
            `| open:${hasError(openMidResult.formatted) ? "ERRORS" : "clean"} ` +
            `err-edit:${hasError(brokenMidResult.formatted) ? firstIssueLine(brokenMidResult.formatted) : "clean!"} ` +
            `| fix:${hasError(fixedMid.formatted) ? firstIssueLine(fixedMid.formatted) : "clean"}` +
            `${openMidResult.timedOut || brokenMidResult.timedOut || fixedMid.timedOut ? " | TIMEOUT" : ""}`,
        );
      }

      // 1. open (clean). Round 0 is the first file on a fresh server.
      const tOpen = Date.now();
      const open = await client.waitForDiagnostics(file, {
        text: clean,
        timeoutMs: WAIT_TIMEOUT_MS,
        minSeverity: 2,
      });
      const openMs = Date.now() - tOpen;

      // 2. edit: type error. Issued immediately after the open returns —
      //    exactly the back-to-back pattern that used to accept a stale burst.
      const tBroken = Date.now();
      const brokenResult = await client.waitForDiagnostics(file, {
        text: broken,
        timeoutMs: WAIT_TIMEOUT_MS,
        minSeverity: 2,
      });
      const brokenMs = Date.now() - tBroken;

      // 3. edit: fix.
      const tFixed = Date.now();
      const fixed = await client.waitForDiagnostics(file, {
        text: clean,
        timeoutMs: WAIT_TIMEOUT_MS,
        minSeverity: 2,
      });
      const fixedMs = Date.now() - tFixed;

      const result: RoundResult = {
        run,
        round,
        cold: round === 0,
        openMs,
        brokenMs,
        fixedMs,
        brokenFormatted: brokenResult.formatted,
        fixedFormatted: fixed.formatted,
        openClean: !hasError(open.formatted),
        brokenErrors: hasError(brokenResult.formatted),
        fixedClean: !hasError(fixed.formatted),
        timedOut: open.timedOut || brokenResult.timedOut || fixed.timedOut,
      };
      results.push(result);

      const ok = !result.timedOut && result.openClean && result.brokenErrors && result.fixedClean;
      if (!ok) failures += 1;
      console.log(
        `${ok ? "PASS" : "FAIL"} run ${run} round ${round}${round === 0 ? " (cold)" : ""} ` +
          `open=${openMs}ms broken=${brokenMs}ms fix=${fixedMs}ms ` +
          `| open:${result.openClean ? "clean" : "ERRORS"} ` +
          `err-edit:${result.brokenErrors ? firstIssueLine(brokenResult.formatted) : "clean!"} ` +
          `| fix:${result.fixedClean ? "clean" : firstIssueLine(fixed.formatted)}` +
          `${result.timedOut ? " | TIMEOUT" : ""}`,
      );
      if (!ok) {
        if (!result.brokenErrors) {
          console.log(
            `    err-edit unexpected output: ${brokenResult.formatted.split("\n").join(" | ") || "<empty>"}`,
          );
        }
        if (!result.timedOut) {
          console.log("    (no timeout — content was reported but wrong)");
        }
      }
    }
  } finally {
    client.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}

const coldFailures = results.filter(
  (r) => r.cold && (r.timedOut || !r.openClean || !r.brokenErrors || !r.fixedClean),
);
console.log(
  `\nserver: ${SERVER_SPEC.label}\n` +
    `${results.length} rounds across ${RUNS} fresh server(s): ` +
    `${results.length - failures} passed, ${failures} failed ` +
    `(cold-start rounds failed: ${coldFailures.length})`,
);
process.exit(failures === 0 ? 0 : 1);
