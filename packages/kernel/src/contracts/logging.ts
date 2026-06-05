/**
 * Logging contract — structured, correlated, span-capable Logger/Span ABI.
 *
 * PURE TYPES ONLY — no implementations. The createLogger factory lives in
 * ../logging/logger.js. The kernel owns types + pure record-builders.
 * NO I/O — the LogSink is injected by the host-bin.
 *
 * Key properties:
 * - P3-safe: correlation flows via explicit child()/span() values, no ambient.
 * - P2: record-builder is pure ({ now, newId } injected).
 * - D3: spans emitted incrementally (open at span(), close at end()).
 * - D6: extensionId auto-stamped by host, not caller-supplied.
 * - Flat scalar attributes (serializable D3, queryable D9).
 * - Optional `body` field on spans for large verbatim payloads (store-fat-serve-thin).
 */

// --- Levels ---

export type Level = "debug" | "info" | "warn" | "error";

// --- Attributes ---

/** Flat, serializable key/value pairs. Caller stringifies nested objects. */
export type Attributes = Readonly<Record<string, string | number | boolean | null>>;

// --- LogContext (correlation) ---

/** Correlation context carried on every log record and span. */
export interface LogContext {
	/** Auto-stamped by host from manifest.id (D6) — never caller-supplied. */
	readonly extensionId: string;
	readonly conversationId?: string;
	readonly turnId?: string;
	readonly spanId?: string;
	readonly parentSpanId?: string;
}

// --- Span ---

/**
 * A timed unit of work within a trace. Opened via `logger.span(name)`,
 * closed via `span.end()`. Emits incremental open/close records so a
 * crashed turn is reconstructable from the journal (D3).
 */
export interface Span {
	readonly id: string;
	/** Pre-bound Logger scoped to this span's correlation. */
	readonly log: Logger;
	/** Add or overwrite attributes on this span. */
	readonly setAttributes: (attrs: Attributes) => void;
	/** Record a causal link to another span (D4 cross-feature causality). */
	readonly addLink: (
		target: { readonly spanId: string; readonly turnId?: string },
		reason?: string,
	) => void;
	/** Open a child span nested under this one. */
	readonly child: (name: string, attrs?: Attributes, body?: string) => Span;
	/**
	 * Close this span. Records duration + status. Optionally records an
	 * error, additional attributes, and/or a body payload.
	 */
	readonly end: (outcome?: {
		readonly err?: unknown;
		readonly attrs?: Attributes;
		readonly body?: string;
	}) => void;
}

// --- Logger ---

/**
 * Structured, correlated logger. The host auto-scopes each extension's
 * logger with its manifest.id as extensionId (D6).
 *
 * `info("msg")` must still compile — attrs is optional (backward compat).
 */
export interface Logger {
	readonly debug: (msg: string, attrs?: Attributes) => void;
	readonly info: (msg: string, attrs?: Attributes) => void;
	readonly warn: (msg: string, attrs?: Attributes) => void;
	readonly error: (msg: string, attrs?: ErrorAttributes) => void;
	/**
	 * Create a child logger with additional correlation context.
	 * Explicit values passed down (P3 — no ambient state).
	 */
	readonly child: (ctx: Partial<LogContext> & { readonly attrs?: Attributes }) => Logger;
	/** Open a new span. Emits a `span-open` record immediately (D3). */
	readonly span: (name: string, attrs?: Attributes, body?: string) => Span;
}

/**
 * Attributes for error log calls. The `err` field is `unknown` (not
 * constrained to Attributes' scalar index signature) so callers can
 * pass `error("msg", { err })` directly.
 */
export interface ErrorAttributes {
	readonly err?: unknown;
	readonly [key: string]: unknown;
}

// --- LogRecord (discriminated union) ---

/**
 * Status of a span. "ok" is the default when no error is recorded.
 */
export type SpanStatus = "ok" | "error";

/**
 * A link to another span, recorded at a handoff moment (D4).
 */
export interface SpanLink {
	readonly spanId: string;
	readonly turnId?: string;
	readonly reason?: string;
}

/**
 * Flat, JSON-serializable discriminated union. Spans are emitted
 * incrementally (open at span(), close at end()) so a crashed turn is
 * reconstructable from the journal (D3).
 *
 * Every variant carries correlation keys + timestamp. An optional `body`
 * field (string) holds large verbatim payloads (store-fat-serve-thin).
 */
export type LogRecord = LogLineRecord | SpanOpenRecord | SpanCloseRecord;

/** A structured log line (debug/info/warn/error). */
export interface LogLineRecord {
	readonly kind: "log";
	readonly level: Level;
	readonly msg: string;
	readonly timestamp: number;
	readonly extensionId: string;
	readonly conversationId?: string;
	readonly turnId?: string;
	readonly spanId?: string;
	readonly parentSpanId?: string;
	readonly attributes?: Attributes;
	/** Optional large verbatim payload (store-fat, serve-thin). */
	readonly body?: string;
}

/** Emitted when a span is opened (at `logger.span(name)`). */
export interface SpanOpenRecord {
	readonly kind: "span-open";
	readonly spanId: string;
	readonly name: string;
	readonly timestamp: number;
	readonly extensionId: string;
	readonly conversationId?: string;
	readonly turnId?: string;
	readonly parentSpanId?: string;
	readonly attributes?: Attributes;
	readonly links?: readonly SpanLink[];
	readonly body?: string;
}

/** Emitted when a span is closed (at `span.end()`). Carries duration + status. */
export interface SpanCloseRecord {
	readonly kind: "span-close";
	readonly spanId: string;
	readonly name: string;
	readonly timestamp: number;
	readonly durationMs: number;
	readonly status: SpanStatus;
	readonly extensionId: string;
	readonly conversationId?: string;
	readonly turnId?: string;
	readonly parentSpanId?: string;
	readonly attributes?: Attributes;
	readonly links?: readonly SpanLink[];
	readonly body?: string;
}

// --- LogSink ---

/**
 * Fire-and-forget sink. The kernel calls emit(); the host-bin injects
 * a concrete implementation. Kernel never lets sink errors escape (D7).
 */
export interface LogSink {
	readonly emit: (record: LogRecord) => void;
}

// --- Deterministic helpers (injected for testability) ---

/** Clock + id generator injected into the logger factory. */
export interface LogDeps {
	readonly now: () => number;
	readonly newId: () => string;
}
