/**
 * Concurrent multi-server diagnostics aggregation.
 *
 * Queries every matching language server AT ONCE (not one-at-a-time), each
 * capped at `timeoutMs`. A server that doesn't push diagnostics within the cap
 * is SKIPPED with a per-server notice rather than blocking the others — so one
 * slow/dead server (e.g. a corrupted Steep) can't hold up the fast one's
 * (ruby-lsp) results for the full timeout on every edit.
 *
 * The only I/O here is `client.waitForDiagnostics` (injected via `getClient`),
 * so this is unit-testable with a fake client and no real process.
 */

import type { LanguageServerClient } from "./client.js";

export interface AggregateServer {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface AggregateOpts {
  /** Post-edit buffer; when omitted the server reads from disk. */
  readonly text?: string | undefined;
  /** Only include diagnostics with severity ≤ this (1=Error, 2=Warning). */
  readonly minSeverity?: number | undefined;
}

export interface AggregateResult {
  /** Merged diagnostics tagged by source + a per-skipped-server notice. */
  readonly formatted: string;
  /** True if at least one server was skipped for exceeding the cap. */
  readonly timedOut: boolean;
}

/**
 * Query `servers` concurrently, each capped at `timeoutMs`. Returns merged
 * diagnostics tagged by source (`[name]\n…`) and, for any server that did not
 * respond in time, a `⚠️ [name] LSP took too long (>Ns), skipped — please raise
 * this to the user.` notice. Never rejects: a client error yields an empty
 * contribution for that server.
 */
export async function aggregateDiagnostics(
  getClient: (id: string, root: string) => LanguageServerClient | undefined,
  servers: readonly AggregateServer[],
  absolutePath: string,
  timeoutMs: number,
  opts: AggregateOpts,
): Promise<AggregateResult> {
  const entries = await Promise.all(
    servers.map(async (server) => {
      const client = getClient(server.id, server.root);
      if (!client) return null;
      const waitOpts: { text?: string; timeoutMs: number; minSeverity?: number } = { timeoutMs };
      if (opts.text !== undefined) waitOpts.text = opts.text;
      if (opts.minSeverity !== undefined) waitOpts.minSeverity = opts.minSeverity;
      const result = await client.waitForDiagnostics(absolutePath, waitOpts);
      return { server, result };
    }),
  );

  const parts: string[] = [];
  let timedOut = false;
  const capSeconds = Math.round(timeoutMs / 1000);

  for (const entry of entries) {
    if (!entry) continue;
    const { server, result } = entry;
    if (result.timedOut) {
      timedOut = true;
      parts.push(
        `⚠️ [${server.name}] LSP took too long (>${capSeconds}s), diagnostics skipped — please raise this to the user.`,
      );
    } else if (result.formatted) {
      parts.push(`[${server.name}]\n${result.formatted}`);
    }
  }

  return { formatted: parts.join("\n\n"), timedOut };
}
