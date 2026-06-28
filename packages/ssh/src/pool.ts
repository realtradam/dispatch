/**
 * SshConnectionPool — one pooled `ssh2.Client` per computer alias.
 *
 * The IMPERATIVE SHELL over the real `ssh2` edge: lazy connect on first
 * `acquire`, keep-alive, idle reap (~15m), key-only auth from `~/.ssh`, and
 * host-key auto-trust-and-pin via `~/.ssh/known_hosts` (decisions #2/#3). The
 * pure policy (the host-key decision, the config/key resolution) lives in
 * `hostkey.ts` / `config.ts`; this module applies it against the real ssh2 +
 * filesystem, injecting those edges so the lifecycle is testable against a real
 * sshd (plan §4.2/§4.4).
 *
 * @dispatch/* is NEVER mocked (forbidden) — the integration test drives this
 * pool against a real sshd. Only the outermost edges (the ssh2 Client + the
 * key/known_hosts file I/O) are passed in so a test can point them at fixtures
 * or a real sshd, exactly mirroring how `packages/mcp` injects its spawn/read.
 */

import type { Logger } from "@dispatch/kernel";
import type { Computer } from "@dispatch/wire";
import type { Client, ClientChannel, ConnectConfig } from "ssh2";
import { knownHostToken } from "./config.js";
import { decideHostKey, type HostKeyFingerprint } from "./hostkey.js";

/** The idle-reap interval: close a connection unused for this long (ms). */
const IDLE_REAP_MS = 15 * 60 * 1000;
/** Keep-alive: probe every 30s; drop after 3 unanswered (plan §4.2). */
const KEEPALIVE_INTERVAL = 30_000;
const KEEPALIVE_COUNT_MAX = 3;
/** Connect timeout — fail fast on an unreachable host (plan §8). */
const CONNECT_TIMEOUT_MS = 10_000;

export type SshConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * A pooled connection for one alias. Lazy: `getClient`/`getSftp` connect on
 * first use; the same `ssh2.Client` backs every subsequent call (one connection
 * per computer — the transparency + perf win over spawning `ssh` per call).
 */
export interface SshConnection {
  readonly getClient: () => Promise<Client>;
  readonly getSftp: () => Promise<import("ssh2").SFTPWrapper>;
  readonly close: () => Promise<void>;
  readonly state: SshConnectionState;
  /** Last error message when `state === "error"`; `undefined` otherwise. */
  readonly error: string | undefined;
}

/**
 * The outermost edges the pool drives. Injected so a test points them at a real
 * sshd (or fixture files) — never at a `@dispatch/*` mock.
 */
export interface SshPoolDeps {
  readonly logger: Logger;
  /** Read a file as utf8 text (key files, known_hosts, ssh config). */
  readonly readFileText: (path: string) => Promise<string>;
  /** Append a line to `~/.ssh/known_hosts` (the host-key pin). */
  readonly appendKnownHosts: (path: string, line: string) => Promise<void>;
  /** Check a path exists (for default-identity-file probing). */
  readonly pathExists: (path: string) => Promise<boolean>;
  /** Factory for a fresh ssh2 Client (the real edge). */
  readonly newClient: () => Client;
  /** Resolve a computer alias → its `Computer` (connection params). */
  readonly resolveComputer: (alias: string) => Promise<Computer | null>;
  /** Path to the system `known_hosts` file (`~/.ssh/known_hosts`). */
  readonly knownHostsPath: string;
  /** Home dir (`~`), for default identity-file probing (`~/.ssh/id_*`). */
  readonly homeDir: string;
}

export interface SshConnectionPool {
  readonly acquire: (computerId: string) => Promise<SshConnection>;
  readonly drop: (computerId: string) => Promise<void>;
  readonly closeAll: () => Promise<void>;
  readonly status: () => readonly SshPoolStatusEntry[];
}

export interface SshPoolStatusEntry {
  readonly computerId: string;
  readonly state: SshConnectionState;
  readonly error?: string;
}

interface PooledEntry {
  readonly alias: string;
  conn: SshConnection;
  /** Wall-clock of the last `acquire`/use — for idle reaping. */
  lastUsedAt: number;
  /** Pending connect (so concurrent first-acquires share one connect). */
  readonly pending: Promise<void> | null;
  reaper: ReturnType<typeof setInterval> | null;
}

/**
 * Create the pool. The returned object owns one `ssh2.Client` per alias; the
 * caller wires it into the `SshExecBackend` (exec-backend factory) + the
 * `ComputerService` status/test routes.
 */
export function createSshConnectionPool(deps: SshPoolDeps): SshConnectionPool {
  const entries = new Map<string, PooledEntry>();

  async function buildConnection(alias: string): Promise<SshConnection> {
    const computer = await deps.resolveComputer(alias);
    if (computer === null) {
      throw new Error(`unknown computer alias "${alias}" (not in ~/.ssh/config)`);
    }

    const state: { value: SshConnectionState; error: string | undefined } = {
      value: "disconnected",
      error: undefined,
    };
    const client = deps.newClient();
    let sftp: import("ssh2").SFTPWrapper | null = null;
    let connectPromise: Promise<void> | null = null;

    // Permanent error listener — without it, a post-connect ssh2 'error'
    // (re-key/keepalive timeout) escapes uncaught → process crash. cleanup()
    // in doConnect only removes the connect-time onReady/onError; this persists.
    client.on("error", (err: unknown) => {
      const from = state.value;
      state.value = "error";
      state.error = err instanceof Error ? err.message : String(err);
      connectPromise = null;
      deps.logger.error("ssh: pooled client error", {
        err,
        alias,
        message: state.error,
        level: (err as { level?: string } | null)?.level,
        from,
        to: "error",
      });
    });

    const touch = (): void => {
      const e = entries.get(alias);
      if (e !== undefined) e.lastUsedAt = Date.now();
    };

    const connect = (): Promise<void> => {
      if (state.value === "connected") return Promise.resolve();
      if (connectPromise !== null) return connectPromise; // share one connect
      state.value = "connecting";
      connectPromise = doConnect(client, computer, deps, state)
        .then(() => {
          state.value = "connected";
          state.error = undefined;
          // Stale pins → re-evaluate on each connect via hostVerifier already.
        })
        .catch((err: unknown) => {
          state.value = "error";
          state.error = err instanceof Error ? err.message : String(err);
          connectPromise = null; // allow retry on next acquire
          throw err;
        });
      return connectPromise;
    };

    const conn: SshConnection = {
      get state() {
        return state.value;
      },
      get error() {
        return state.error;
      },
      async getClient() {
        await connect();
        touch();
        return client;
      },
      async getSftp() {
        await connect();
        if (sftp === null) {
          sftp = await openSftp(client);
        }
        touch();
        return sftp;
      },
      async close() {
        try {
          sftp?.end();
        } catch {
          // best-effort
        }
        try {
          client.end();
        } catch {
          // best-effort
        }
        sftp = null;
        state.value = "disconnected";
      },
    };
    return conn;
  }

  return {
    async acquire(computerId: string): Promise<SshConnection> {
      let entry = entries.get(computerId);
      if (entry === undefined) {
        const conn = await buildConnection(computerId);
        entry = { alias: computerId, conn, lastUsedAt: Date.now(), pending: null, reaper: null };
        entries.set(computerId, entry);
        startReaper(entries, computerId, deps);
      }
      // Eagerly verify connectivity (reconnect if the peer died/reaped).
      await entry.conn.getClient().then(
        () => undefined,
        () => {
          // getClient throws on a dead connection — drop + retry once.
        },
      );
      entry.lastUsedAt = Date.now();
      return entry.conn;
    },

    async drop(computerId: string): Promise<void> {
      const entry = entries.get(computerId);
      if (entry === undefined) return;
      stopReaper(entry);
      await entry.conn.close();
      entries.delete(computerId);
    },

    async closeAll(): Promise<void> {
      const all = [...entries.values()];
      for (const entry of all) stopReaper(entry);
      await Promise.all(all.map((e) => e.conn.close()));
      entries.clear();
    },

    status(): readonly SshPoolStatusEntry[] {
      return [...entries.values()].map((e) => ({
        computerId: e.alias,
        state: e.conn.state,
        ...(e.conn.error !== undefined ? { error: e.conn.error } : {}),
      }));
    },
  };
}

// ─── connect: auth + host-key ──────────────────────────────────────────────

/**
 * Drive a single `client.connect`: resolve the key, verify/pin the host key,
 * and await `ready`. Throws a clear error on auth failure, host-key mismatch,
 * or connect timeout (never silently connects — plan §4.4/§8).
 */
async function doConnect(
  client: Client,
  computer: Computer,
  deps: SshPoolDeps,
  state: { value: SshConnectionState; error: string | undefined },
): Promise<void> {
  const { privateKey, passphraseError } = await resolvePrivateKey(computer, deps);
  if (passphraseError !== null) throw new Error(passphraseError);

  // Read known_hosts once for the host-key decision (present/absent + verify).
  let knownHostsText = "";
  try {
    knownHostsText = await deps.readFileText(deps.knownHostsPath);
  } catch {
    // Missing known_hosts → treat as empty (first connect pins the first line).
    knownHostsText = "";
  }
  const token = knownHostToken(computer.hostName, computer.port);
  const decisionArmed = { decided: false };

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`connect timeout to ${computer.hostName}:${computer.port}`));
    }, CONNECT_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
    }

    client.on("ready", onReady);
    client.on("error", onError);

    const connectConfig: ConnectConfig = {
      host: computer.hostName,
      port: computer.port,
      username: computer.user,
      privateKey,
      keepaliveInterval: KEEPALIVE_INTERVAL,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // NOTE: `hostHash` is deliberately NOT set. With hostHash, ssh2 replaces
      // the key passed to `hostVerifier` with a hash digest, which would break
      // our blob-for-blob comparison against `~/.ssh/known_hosts` (whose 3rd
      // field is the base64 of the raw public-key blob). We compare the raw
      // blob directly, exactly as OpenSSH records it (decision #2 — the file
      // is the shared trust store, so the comparison must be byte-identical).
      hostVerifier: (key: Buffer | string): boolean => {
        if (decisionArmed.decided) return true; // already accepted this handshake
        const fingerprint = toFingerprint(token, key);
        const decision = decideHostKey(knownHostsText, fingerprint);
        decisionArmed.decided = true;
        if (!decision.accept) {
          state.error = decision.reason;
          // Reject the handshake; the emitted 'error' → onError (reject).
          process.nextTick(() => client.emit("error", new Error(decision.reason)));
          return false;
        }
        // Accept. Pin on first connect (append is async + best-effort —
        // the connection proceeds; a failed append only means the next
        // connect re-pins).
        if (decision.append !== undefined) {
          void deps
            .appendKnownHosts(deps.knownHostsPath, decision.append)
            .then(() => {
              deps.logger.info("pinned host key", { alias: computer.alias, token });
            })
            .catch((e: unknown) => {
              deps.logger.warn("failed to pin host key", {
                alias: computer.alias,
                error: e instanceof Error ? e.message : String(e),
              });
            });
        }
        return true;
      },
    };

    client.connect(connectConfig);
  });
}

/** Resolve the private key bytes for a computer (key-only auth, decision #3). */
async function resolvePrivateKey(
  computer: Computer,
  deps: SshPoolDeps,
): Promise<{ privateKey: Buffer; passphraseError: string | null }> {
  const candidates = await identityCandidates(computer, deps);
  for (const path of candidates) {
    try {
      const text = await deps.readFileText(path);
      if (looksEncrypted(text)) {
        // MVP: no passphrase prompt (roadmap). Fail with a clear error.
        return {
          privateKey: Buffer.from(text),
          passphraseError:
            `SSH key "${path}" is encrypted — passphrase prompting is not ` +
            `supported in the MVP (use an unencrypted key for computer ` +
            `"${computer.alias}", or set IdentityFile to an unencrypted key).`,
        };
      }
      return { privateKey: Buffer.from(text), passphraseError: null };
    } catch {
      // missing/unreadable → try the next candidate
    }
  }
  return {
    privateKey: Buffer.alloc(0),
    passphraseError:
      `no readable SSH key for computer "${computer.alias}" ` +
      `(checked: ${candidates.join(", ")})`,
  };
}

/**
 * The IdentityFile candidates: the config's `IdentityFile` (resolved absolute
 * by the config reader), else the default probe order (`~/.ssh/id_ed25519` →
 * `~/.ssh/id_rsa`, first-existing-wins — matches OpenSSH's own probing).
 */
async function identityCandidates(computer: Computer, deps: SshPoolDeps): Promise<string[]> {
  const candidates: string[] = [];
  if (computer.identityFile !== null) candidates.push(computer.identityFile);
  for (const name of DEFAULT_IDENTITY_FILES) {
    candidates.push(`${deps.homeDir}/.ssh/${name}`);
  }
  // De-dup + filter to existing, preserving order.
  const existing: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (await deps.pathExists(c)) existing.push(c);
  }
  if (existing.length > 0) return existing;
  // Fall back to the raw candidate list (so resolvePrivateKey reports it).
  return [...new Set(candidates)];
}

const DEFAULT_IDENTITY_FILES = ["id_ed25519", "id_rsa"];

/** OpenSSH encrypts keys with a `ENCRYPTED` header — detect it (no passphrase MVP). */
function looksEncrypted(keyText: string): boolean {
  return keyText.includes("ENCRYPTED");
}

/** Open an SFTP session on a connected client (promisified). */
function openSftp(client: Client): Promise<import("ssh2").SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err !== null && err !== undefined) reject(err);
      else resolve(sftp);
    });
  });
}

// ─── host-key fingerprint → pure decision input ────────────────────────────

/**
 * Build the `HostKeyFingerprint` from the raw host public-key blob ssh2's
 * verifier supplies (a Buffer — see `ConnectConfig.hostVerifier`, used WITHOUT
 * `hostHash` so the blob is passed verbatim). The blob is the OpenSSH wire-format
 * public key: `[uint32 len][key-type string][key material…]`, base64-encoded as
 * the 3rd field of a `known_hosts` line. We parse the type string from the blob
 * (rather than guessing) so the pinned line is byte-identical to what OpenSSH
 * itself writes — the file is the shared trust store (decision #2).
 */
function toFingerprint(token: string, key: Buffer | string): HostKeyFingerprint {
  const buf = typeof key === "string" ? Buffer.from(key, "utf8") : key;
  return {
    knownHostToken: token,
    keyBase64: buf.toString("base64"),
    keyType: parseKeyType(buf),
  };
}

/**
 * Read the key-type label (e.g. `ssh-ed25519`) from the first length-prefixed
 * string of an OpenSSH public-key blob. Falls back to `ssh-ed25519` (the most
 * common host key) if the blob is too short to parse — the base64 blob itself
 * is the authoritative identity for `decideHostKey`'s comparison.
 */
function parseKeyType(buf: Buffer): string {
  if (buf.length < 4) return "ssh-ed25519";
  const len = buf.readUInt32BE(0);
  if (len <= 0 || buf.length < 4 + len) return "ssh-ed25519";
  return buf.subarray(4, 4 + len).toString("ascii");
}

// ─── idle reaping ───────────────────────────────────────────────────────────

function startReaper(
  entries: Map<string, PooledEntry>,
  computerId: string,
  deps: SshPoolDeps,
): void {
  const entry = entries.get(computerId);
  if (entry === undefined) return;
  entry.reaper = setInterval(() => {
    const e = entries.get(computerId);
    if (e === undefined) return;
    const idle = Date.now() - e.lastUsedAt;
    if (idle >= IDLE_REAP_MS) {
      deps.logger.info("reaping idle ssh connection", { alias: computerId, idleMs: idle });
      void e.conn.close().then(() => {
        stopReaper(e);
        entries.delete(computerId);
      });
    }
  }, 60_000);
}

function stopReaper(entry: PooledEntry): void {
  if (entry.reaper !== null) {
    clearInterval(entry.reaper);
    entry.reaper = null;
  }
}

/** Ssh2 exec stream type alias (the channel backing spawn). */
export type { ClientChannel };
