import type { Logger } from "@dispatch/kernel";

export interface ChildHandle {
  readonly kill: (signal?: string) => void;
  readonly exited: Promise<number>;
}

export interface SupervisorDeps {
  readonly spawn: (cmd: string[]) => ChildHandle;
  readonly journalPath: string;
  readonly dbPath: string;
  readonly interval?: number;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

const RESTART_WINDOW_MS = 10_000;
const MAX_RESTARTS_IN_WINDOW = 5;
const BACKOFF_BASE_MS = 500;
const STOP_TIMEOUT_MS = 5_000;

export function createCollectorSupervisor(deps: SupervisorDeps): {
  start: () => void;
  stop: () => Promise<void>;
} {
  const {
    spawn,
    journalPath,
    dbPath,
    interval,
    logger,
    now = () => Date.now(),
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;

  let child: ChildHandle | null = null;
  let stopping = false;
  const restartTimestamps: number[] = [];

  function buildCmd(): string[] {
    const cmd = [
      "bun",
      "packages/observability-collector/src/main.ts",
      "--journal",
      journalPath,
      "--db",
      dbPath,
    ];
    if (interval !== undefined) {
      cmd.push("--interval", String(interval));
    }
    return cmd;
  }

  function pruneOldRestarts(): void {
    const cutoff = now() - RESTART_WINDOW_MS;
    while (restartTimestamps.length > 0) {
      const oldest = restartTimestamps[0];
      if (oldest === undefined || oldest > cutoff) break;
      restartTimestamps.shift();
    }
  }

  function shouldRestart(): boolean {
    pruneOldRestarts();
    return restartTimestamps.length < MAX_RESTARTS_IN_WINDOW;
  }

  function getBackoffMs(): number {
    return BACKOFF_BASE_MS * 2 ** restartTimestamps.length;
  }

  function onChildExit(code: number): void {
    child = null;
    if (stopping) return;

    logger.warn("Collector exited unexpectedly", { code } as never);
    if (!shouldRestart()) {
      logger.warn("Collector restart cap reached; giving up", {
        restarts: restartTimestamps.length,
        windowMs: RESTART_WINDOW_MS,
      } as never);
      return;
    }

    restartTimestamps.push(now());
    const backoff = getBackoffMs();
    logger.info("Restarting collector after backoff", { backoffMs: backoff } as never);
    delay(backoff)
      .then(() => {
        if (!stopping) spawnChild();
      })
      .catch(() => {});
  }

  function spawnChild(): void {
    try {
      const handle = spawn(buildCmd());
      child = handle;
      logger.info("Collector started");
      handle.exited.then(
        (code) => onChildExit(code),
        () => {},
      );
    } catch (err) {
      logger.warn("Failed to spawn collector", { err } as never);
    }
  }

  function start(): void {
    spawnChild();
  }

  async function stop(): Promise<void> {
    stopping = true;
    if (!child) return;

    const handle = child;
    handle.kill("SIGTERM");

    let resolved = false;
    const exitedPromise = handle.exited.then(() => {
      resolved = true;
    });

    const timeoutPromise = delay(STOP_TIMEOUT_MS).then(() => {
      if (!resolved) {
        handle.kill("SIGKILL");
        return handle.exited;
      }
    });

    await Promise.race([exitedPromise, timeoutPromise]);
  }

  return { start, stop };
}
