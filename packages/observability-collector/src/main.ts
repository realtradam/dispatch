import { createTraceStore, DEFAULT_RETENTION } from "@dispatch/trace-store";
import type { Logger } from "./collector.js";
import { drainOnce, readOffset, shouldPrune, writeOffset } from "./collector.js";

// --- Argv parsing ---

interface CliArgs {
  readonly journal: string;
  readonly db: string;
  readonly interval: number;
  readonly pruneIntervalMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  let journal = "";
  let db = "./.dispatch-data/traces.db";
  let interval = 250;
  let pruneIntervalMs = 60_000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--journal" && i + 1 < argv.length) {
      journal = argv[i + 1] ?? "";
      i++;
    } else if (arg === "--db" && i + 1 < argv.length) {
      db = argv[i + 1] ?? db;
      i++;
    } else if (arg === "--interval" && i + 1 < argv.length) {
      const val = Number(argv[i + 1]);
      if (Number.isFinite(val) && val > 0) interval = val;
      i++;
    } else if (arg === "--prune-interval-ms" && i + 1 < argv.length) {
      const val = Number(argv[i + 1]);
      if (Number.isFinite(val) && val > 0) pruneIntervalMs = val;
      i++;
    }
  }

  if (!journal) {
    console.error(
      "Usage: observability-collector --journal <path> [--db <path>] [--interval <ms>] [--prune-interval-ms <ms>]",
    );
    process.exit(1);
  }

  return { journal, db, interval, pruneIntervalMs };
}

// --- Logger ---

const logger: Logger = {
  info: (...args: readonly unknown[]) => console.log("[observability-collector]", ...args),
  debug: (...args: readonly unknown[]) => console.debug("[observability-collector]", ...args),
};

// --- Main loop ---

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sidecarPath = `${args.journal}.collector-offset`;
  const store = createTraceStore({ path: args.db });

  let offset = readOffset(sidecarPath);
  let lastPruneAt = Date.now();

  let shuttingDown = false;

  function onSignal(): void {
    if (shuttingDown) return;
    shuttingDown = true;
  }

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  while (!shuttingDown) {
    const result = drainOnce({ journalPath: args.journal, offset, store });
    if (result.newOffset !== offset) {
      offset = result.newOffset;
      writeOffset(sidecarPath, offset);
    }

    const now = Date.now();
    if (shouldPrune(now, lastPruneAt, args.pruneIntervalMs)) {
      lastPruneAt = now;
      try {
        const summary = store.prune(DEFAULT_RETENTION);
        logger.debug("prune completed", summary);
      } catch (err) {
        logger.info("prune failed (non-fatal)", err);
      }
    }

    await sleep(args.interval);
  }

  // Final drain on shutdown
  const finalResult = drainOnce({ journalPath: args.journal, offset, store });
  if (finalResult.newOffset !== offset) {
    writeOffset(sidecarPath, finalResult.newOffset);
  }

  store.close();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[observability-collector] fatal:", err);
  process.exit(1);
});
