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

	setPushDiagnostics(params: PublishDiagnosticsParams): void {
		this.pushDiagnostics.set(params.uri, params.diagnostics);
		this.pushReceived.add(params.uri);
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

function diagnosticKey(d: Diagnostic): string {
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
