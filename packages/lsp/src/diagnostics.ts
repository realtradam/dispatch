/**
 * Diagnostics — merge push (textDocument/publishDiagnostics) + pull
 * (textDocument/diagnostic) per file, dedupe, and format.
 */

export interface Diagnostic {
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
  readonly severity?: number;
  readonly source?: string;
  readonly message: string;
  readonly code?: string | number;
}

export interface PublishDiagnosticsParams {
  readonly uri: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DocumentDiagnosticReport {
  readonly kind: "full" | "unchanged";
  readonly items?: readonly Diagnostic[];
}

const severityNames: Record<number, string> = {
  1: "ERROR",
  2: "WARNING",
  3: "INFO",
  4: "HINT",
};

export class DiagnosticsStore {
  private pushDiagnostics = new Map<string, readonly Diagnostic[]>();
  private pullDiagnostics = new Map<string, readonly Diagnostic[]>();
  private pushReceived = new Set<string>();
  /**
   * Bounded push-diagnostics set: once more than this many URIs have cached
   * push diagnostics, the least-recently-pushed is evicted (just deleted —
   * no didClose, since these are often background-scanned files the agent
   * never opened). Language servers (tsserver, rust-analyzer, …) scan the
   * workspace and emit textDocument/publishDiagnostics for files the client
   * never touched; those never enter the client's openDocuments LRU, so
   * without this cap the map grew without bound over a long session.
   */
  private static readonly MAX_PUSH_DIAGNOSTICS = 100;

  setPushDiagnostics(params: PublishDiagnosticsParams): void {
    // Delete-then-set to refresh LRU recency: a URI re-pushed (e.g. an
    // actively edited file) moves to the tail (most-recently-used), so
    // background-scanned files pushed once drift to the head and are evicted
    // first. Mirrors the openDocuments LRU in client.ts. (A plain `set` on
    // an existing key updates the value but leaves its insertion position —
    // and thus its eviction priority — unchanged.)
    this.pushDiagnostics.delete(params.uri);
    this.pushDiagnostics.set(params.uri, params.diagnostics);
    this.pushReceived.add(params.uri);
    this.evictPushIfOverCap();
  }

  /**
   * If the push-diagnostics set exceeds MAX_PUSH_DIAGNOSTICS, drop the
   * least-recently-pushed entry (the first key in insertion order) from
   * both `pushDiagnostics` and `pushReceived`. No didClose is sent: these
   * entries are frequently for files the agent never opened, and even for
   * an opened file the next push re-caches it.
   */
  private evictPushIfOverCap(): void {
    while (this.pushDiagnostics.size > DiagnosticsStore.MAX_PUSH_DIAGNOSTICS) {
      const oldest = this.pushDiagnostics.keys().next().value;
      if (oldest === undefined) break;
      this.pushDiagnostics.delete(oldest);
      this.pushReceived.delete(oldest);
    }
  }

  setPullDiagnostics(uri: string, report: DocumentDiagnosticReport): void {
    if (report.kind === "full" && report.items) {
      this.pullDiagnostics.set(uri, report.items);
    }
  }

  /** True if the server has pushed at least one publishDiagnostics for this URI. */
  hasReceivedPush(uri: string): boolean {
    return this.pushReceived.has(uri);
  }

  /** Clear the "received" flag so the next waitForDiagnostics poll detects fresh pushes. */
  clearReceived(uri: string): void {
    this.pushReceived.delete(uri);
  }

  /**
   * Drop ALL state for a URI — push diagnostics, pull diagnostics, and the
   * received flag. Called when a document is closed (textDocument/didClose)
   * so the store stops retaining the file's diagnostics forever. Without
   * this, the maps grow unboundedly as an agent touches thousands of files
   * (the 9.5 GB leak).
   */
  purge(uri: string): void {
    this.pushDiagnostics.delete(uri);
    this.pullDiagnostics.delete(uri);
    this.pushReceived.delete(uri);
  }

  getMerged(uri: string): readonly Diagnostic[] {
    const push = this.pushDiagnostics.get(uri) ?? [];
    const pull = this.pullDiagnostics.get(uri) ?? [];
    return dedupeDiagnostics([...push, ...pull]);
  }

  /**
   * Format diagnostics for a URI, optionally filtering by minimum severity.
   * `minSeverity` includes only diagnostics with severity ≤ the given value
   * (1=Error, 2=Warning, 3=Info, 4=Hint). Omit to include all.
   */
  formatFiltered(uri: string, minSeverity?: number): string {
    let diags = this.getMerged(uri);
    if (minSeverity !== undefined) {
      diags = diags.filter((d) => (d.severity ?? 0) <= minSeverity);
    }
    if (diags.length === 0) return "";
    const lines: string[] = [];
    for (const d of diags) {
      const sev = d.severity ? (severityNames[d.severity] ?? "UNKNOWN") : "UNKNOWN";
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const src = d.source ? ` [${d.source}]` : "";
      const code = d.code ? ` (${d.code})` : "";
      lines.push(`${sev}${code}${src} L${line}:${col}: ${d.message}`);
    }
    return lines.join("\n");
  }

  format(uri: string): string {
    return this.formatFiltered(uri);
  }
}

export function diagnosticKey(d: Diagnostic): string {
  const r = d.range;
  return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}:${d.severity ?? 0}:${d.message}`;
}

function dedupeDiagnostics(diags: readonly Diagnostic[]): readonly Diagnostic[] {
  const seen = new Set<string>();
  const result: Diagnostic[] = [];
  for (const d of diags) {
    const key = diagnosticKey(d);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(d);
    }
  }
  return result;
}
