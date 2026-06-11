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

	setPushDiagnostics(params: PublishDiagnosticsParams): void {
		this.pushDiagnostics.set(params.uri, params.diagnostics);
	}

	setPullDiagnostics(uri: string, report: DocumentDiagnosticReport): void {
		if (report.kind === "full" && report.items) {
			this.pullDiagnostics.set(uri, report.items);
		}
	}

	getMerged(uri: string): readonly Diagnostic[] {
		const push = this.pushDiagnostics.get(uri) ?? [];
		const pull = this.pullDiagnostics.get(uri) ?? [];
		return dedupeDiagnostics([...push, ...pull]);
	}

	format(uri: string): string {
		const diags = this.getMerged(uri);
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
