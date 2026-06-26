/**
 * Host-key trust decision — the `accept-new` (auto-trust-and-pin) analog.
 *
 * Per decisions #2/#3: on connect, the ssh2 `hostVerifier` checks whether the
 * host's key is in `~/.ssh/known_hosts`. If present → verify match (reject on
 * mismatch, surface "HOST KEY CHANGED" loudly). If absent (first connect) →
 * accept + append the fingerprint to `known_hosts` (the pin). A future FE
 * "approve host key" prompt (roadmap) would gate that first accept.
 *
 * The DECISION is PURE (input → output, no I/O, zero mocks): given the current
 * known_hosts text + the host + its key fingerprint, decide accept/reject and
 * (if pinning) produce the line to append. The I/O — reading/append-writing the
 * real `~/.ssh/known_hosts` file — lives in the `SshConnectionPool` shell, which
 * injects the text + applies the append. This keeps the policy unit-testable
 * against fixture strings (plan §4.4).
 */

/** Outcome of a host-key check. The shell acts on `accept` + `append`. */
export interface HostKeyDecision {
  /** Accept the connection (true) or reject it loudly (false). */
  readonly accept: boolean;
  /**
   * When the host is unseen (first connect), the line to append to
   * `known_hosts` to pin the key. `undefined` when the host is already known
   * (no write needed) or when rejecting (do not pin a mismatched key).
   */
  readonly append: string | undefined;
  /** Human-readable reason for logging/the rejection error. */
  readonly reason: string;
}

/**
 * The host-key verification fingerprint. ssh2 hands the verifier the raw host
 * key Buffer; the shell computes a fingerprint string (e.g. an OpenSSH-style
 * `SHA256:...` hex) + the key type + the line OpenSSH would write (the `host`
 * token + base64 key) so the decision is string-comparable against known_hosts.
 *
 * Carrying the exact line OpenSSH itself writes keeps `~/.ssh/known_hosts`
 * interchangeable with the real ssh client (decision #2 — the file is the
 * shared trust store).
 */
export interface HostKeyFingerprint {
  /** The OpenSSH `known_hosts` line token, e.g. `[localhost]:2222` or `myhost`. */
  readonly knownHostToken: string;
  /** The base64-encoded public key (the 2nd field of a known_hosts line). */
  readonly keyBase64: string;
  /** Key type label, e.g. `ssh-ed25519` (the 1st field). */
  readonly keyType: string;
}

/**
 * Decide whether to accept a host key, given the current `known_hosts` text.
 *
 * The matching mirrors OpenSSH's `known_hosts` semantics at the granularity the
 * MVP needs: a line whose FIRST field equals `fingerprint.knownHostToken` is a
 * match for that host. (OpenSSH also supports comma-host + hash + wildcard
 * tokens; the MVP pins one explicit token per host — the shell writes exactly
 * the token ssh2 supplied — so a plain first-field compare is correct and
 * sufficient. A full known_hosts parser is a roadmap item.)
 *
 * - **present + key matches** → accept, no append (already pinned).
 * - **present + key differs** → REJECT ("HOST KEY CHANGED" — never silently
 *   connect; this is the MITM guard).
 * - **absent (first connect)** → accept + append the pin line.
 *
 * Pure: `knownHostsText` + `fingerprint` → `HostKeyDecision`.
 */
export function decideHostKey(
  knownHostsText: string,
  fingerprint: HostKeyFingerprint,
): HostKeyDecision {
  const { knownHostToken, keyBase64, keyType } = fingerprint;
  const expectedLine = `${knownHostToken} ${keyType} ${keyBase64}`;

  // A line matches THIS host when its first field is the knownHostToken.
  const existing = findHostLine(knownHostsText, knownHostToken);

  if (existing === undefined) {
    // Absent → first connect → accept + pin (the accept-new analog).
    return {
      accept: true,
      append: expectedLine,
      reason: `first connect to "${knownHostToken}": pinning host key`,
    };
  }

  // Present → compare the key material (fields 2+3). Ignore leading/trailing
  // whitespace differences (OpenSSH tolerates these).
  const normalizedExisting = normalizeLine(existing);
  if (normalizedExisting === normalizeLine(expectedLine)) {
    return { accept: true, append: undefined, reason: `host key for "${knownHostToken}" matches` };
  }

  // Present but DIFFERENT → reject loudly. Do NOT pin (the key changed →
  // possible MITM; the user must clear the stale line manually).
  return {
    accept: false,
    append: undefined,
    reason:
      `HOST KEY CHANGED for "${knownHostToken}" — refusing to connect ` +
      `(remove the stale entry from ~/.ssh/known_hosts if this change is expected)`,
  };
}

/** Find the first known_hosts line whose first field is `token`. Pure. */
function findHostLine(text: string, token: string): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // First whitespace-delimited field is the host token (possibly comma-list).
    const firstSpace = findFirstSpace(line);
    const firstField = firstSpace === -1 ? line : line.slice(0, firstSpace);
    // A token may be a comma-separated host list; accept if any element matches.
    if (
      firstField
        .split(",")
        .map((h) => h.trim())
        .includes(token)
    ) {
      return line;
    }
  }
  return undefined;
}

/** Normalize a known_hosts line for key-material comparison (host-independent). */
function normalizeLine(line: string): string {
  const parts = line.split(/\s+/).filter((p) => p.length > 0);
  // Drop the first field (host token); compare key-type + base64 key.
  return parts.slice(1).join(" ");
}

function findFirstSpace(line: string): number {
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 32 || ch === 9) return i; // space or tab
  }
  return -1;
}

/**
 * Read whether a host appears in `known_hosts` at all (for the read-only
 * `Computer.knownHost` view surfaced by `GET /computers`). Pure. Uses the same
 * first-field matching as `decideHostKey`.
 */
export function isKnownHost(knownHostsText: string, token: string): boolean {
  return findHostLine(knownHostsText, token) !== undefined;
}
