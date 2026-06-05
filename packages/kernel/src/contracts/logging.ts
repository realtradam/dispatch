/**
 * Logging contract — structured, correlated, span-capable Logger/Span ABI.
 *
 * The kernel owns types + pure record-builders. NO I/O — the LogSink is
 * injected by the host-bin. Logger/Span mint records and call sink.emit;
 * sink errors are swallowed (D7 — the turn is sovereign).
 *
 * Key properties:
 * - P3-safe: correlation flows via explicit child()/span() values, no ambient.
 * - P2: record-builder is pure ({ now, newId } injected).
 * - D3: spans emitted incrementally (open at span(), close at end()).
 * - D6: extensionId auto-stamped by host, not caller-supplied.
 * - Flat scalar attributes (serializable D3, queryable D9).
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
	readonly child: (name: string, attrs?: Attributes) => Span;
	/**
	 * Close this span. Records duration + status. Optionally records an
	 * error and/or additional attributes.
	 */
	readonly end: (outcome?: { readonly err?: unknown; readonly attrs?: Attributes }) => void;
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
	readonly span: (name: string, attrs?: Attributes) => Span;
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

// --- Pure record builder (no I/O) ---

/**
 * Internal state carried by a logger instance. Built by createLogger;
 * never exposed outside this module.
 */
interface LoggerState {
	readonly ctx: LogContext;
	readonly attrs: Attributes | undefined;
	readonly deps: LogDeps;
	readonly sink: LogSink;
}

function mergeAttributes(
	base: Attributes | undefined,
	extra: Attributes | undefined,
): Attributes | undefined {
	if (base === undefined && extra === undefined) return undefined;
	if (base === undefined) return extra;
	if (extra === undefined) return base;
	return { ...base, ...extra };
}

function isScalarAttr(value: unknown): value is string | number | boolean | null {
	const t = typeof value;
	return t === "string" || t === "number" || t === "boolean" || value === null;
}

function emitLog(state: LoggerState, level: Level, msg: string, attrs?: Attributes): void {
	const merged = mergeAttributes(state.attrs, attrs);
	const base = {
		kind: "log" as const,
		level,
		msg,
		timestamp: state.deps.now(),
		extensionId: state.ctx.extensionId,
	};
	const record: LogLineRecord =
		state.ctx.conversationId !== undefined ||
		state.ctx.turnId !== undefined ||
		state.ctx.spanId !== undefined ||
		state.ctx.parentSpanId !== undefined ||
		merged !== undefined
			? {
					...base,
					...(state.ctx.conversationId !== undefined
						? { conversationId: state.ctx.conversationId }
						: {}),
					...(state.ctx.turnId !== undefined ? { turnId: state.ctx.turnId } : {}),
					...(state.ctx.spanId !== undefined ? { spanId: state.ctx.spanId } : {}),
					...(state.ctx.parentSpanId !== undefined ? { parentSpanId: state.ctx.parentSpanId } : {}),
					...(merged !== undefined ? { attributes: merged } : {}),
				}
			: base;
	try {
		state.sink.emit(record);
	} catch {
		// Swallow — D7: the turn is sovereign (never break the caller).
	}
}

function buildSpanOpen(
	state: LoggerState,
	name: string,
	spanId: string,
	attrs?: Attributes,
): SpanOpenRecord {
	const base = {
		kind: "span-open" as const,
		spanId,
		name,
		timestamp: state.deps.now(),
		extensionId: state.ctx.extensionId,
	};
	const merged = mergeAttributes(state.attrs, attrs);
	return {
		...base,
		...(state.ctx.conversationId !== undefined ? { conversationId: state.ctx.conversationId } : {}),
		...(state.ctx.turnId !== undefined ? { turnId: state.ctx.turnId } : {}),
		...(state.ctx.parentSpanId !== undefined ? { parentSpanId: state.ctx.parentSpanId } : {}),
		...(merged !== undefined ? { attributes: merged } : {}),
	};
}

function buildSpanLink(
	target: { readonly spanId: string; readonly turnId?: string },
	reason?: string,
): SpanLink {
	return {
		spanId: target.spanId,
		...(target.turnId !== undefined ? { turnId: target.turnId } : {}),
		...(reason !== undefined ? { reason } : {}),
	};
}

/**
 * Create a structured Logger. Pure factory — all I/O goes through the
 * injected sink. `{ now, newId }` are injected for deterministic tests.
 *
 * @param ctx  Initial correlation context (extensionId + optional ids).
 * @param sink  Fire-and-forget record sink.
 * @param deps  Clock + id generator.
 * @param attrs  Optional default attributes (from child()).
 */
export function createLogger(
	ctx: LogContext,
	sink: LogSink,
	deps: LogDeps,
	attrs?: Attributes,
): Logger {
	const state: LoggerState = { ctx, attrs, deps, sink };

	function makeSpan(name: string, spanAttrs?: Attributes, parentSpanId?: string): Span {
		const spanId = deps.newId();
		const mergedParent = parentSpanId ?? state.ctx.spanId;
		const spanCtx: LogContext = {
			extensionId: ctx.extensionId,
			...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
			...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
			spanId,
			...(mergedParent !== undefined ? { parentSpanId: mergedParent } : {}),
		};

		const openRecord = buildSpanOpen(state, name, spanId, spanAttrs);
		const spanAttrsMutable: Record<string, string | number | boolean | null> =
			spanAttrs !== undefined ? { ...spanAttrs } : {};
		const links: SpanLink[] = [];
		const openedAt = deps.now();

		try {
			sink.emit(openRecord);
		} catch {
			// Swallow — D7.
		}

		const spanLogger = createLogger(spanCtx, sink, deps, state.attrs);

		const span: Span = {
			id: spanId,
			log: spanLogger,
			setAttributes(newAttrs: Attributes): void {
				for (const [key, value] of Object.entries(newAttrs)) {
					spanAttrsMutable[key] = value;
				}
			},
			addLink(target, reason): void {
				links.push(buildSpanLink(target, reason));
			},
			child(childName: string, childAttrs?: Attributes): Span {
				return makeSpan(childName, childAttrs, spanId);
			},
			end(outcome?): void {
				const closedAt = deps.now();
				const err = outcome?.err;
				let status: SpanStatus = "ok";
				if (err !== undefined && err !== null) {
					status = "error";
					const errMsg = err instanceof Error ? err.message : String(err);
					spanAttrsMutable["error.message"] = errMsg;
					if (err instanceof Error && err.stack !== undefined) {
						spanAttrsMutable["error.stack"] = err.stack;
					}
				}
				if (outcome?.attrs !== undefined) {
					for (const [key, value] of Object.entries(outcome.attrs)) {
						spanAttrsMutable[key] = value;
					}
				}

				const hasAttrs = Object.keys(spanAttrsMutable).length > 0;
				const hasLinks = links.length > 0;
				const base = {
					kind: "span-close" as const,
					spanId,
					name,
					timestamp: closedAt,
					durationMs: closedAt - openedAt,
					status,
					extensionId: ctx.extensionId,
				};
				const closeRecord: SpanCloseRecord = {
					...base,
					...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
					...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
					...(mergedParent !== undefined ? { parentSpanId: mergedParent } : {}),
					...(hasAttrs ? { attributes: { ...spanAttrsMutable } } : {}),
					...(hasLinks ? { links: [...links] } : {}),
				};
				try {
					sink.emit(closeRecord);
				} catch {
					// Swallow — D7.
				}
			},
		};

		return span;
	}

	const logger: Logger = {
		debug(msg: string, attrs?: Attributes): void {
			emitLog(state, "debug", msg, attrs);
		},
		info(msg: string, attrs?: Attributes): void {
			emitLog(state, "info", msg, attrs);
		},
		warn(msg: string, attrs?: Attributes): void {
			emitLog(state, "warn", msg, attrs);
		},
		error(msg: string, attrs?: ErrorAttributes): void {
			const err = attrs?.err;
			if (err !== undefined && err !== null) {
				// Extract scalar attributes (everything except err).
				const scalarAttrs: Record<string, string | number | boolean | null> = {};
				if (attrs !== undefined) {
					for (const [key, value] of Object.entries(attrs)) {
						if (key !== "err" && isScalarAttr(value)) {
							scalarAttrs[key] = value;
						}
					}
				}
				const merged = mergeAttributes(
					state.attrs,
					Object.keys(scalarAttrs).length > 0 ? scalarAttrs : undefined,
				);
				const errMsg = err instanceof Error ? err.message : String(err);
				const errorAttrs: Record<string, string | number | boolean | null> = {
					...(merged ?? {}),
					"error.message": errMsg,
				};
				if (err instanceof Error && err.stack !== undefined) {
					errorAttrs["error.stack"] = err.stack;
				}
				emitLog(state, "error", msg, errorAttrs as Attributes);
			} else {
				// No err field — filter to scalar attributes only.
				const scalarAttrs: Record<string, string | number | boolean | null> = {};
				if (attrs !== undefined) {
					for (const [key, value] of Object.entries(attrs)) {
						if (isScalarAttr(value)) {
							scalarAttrs[key] = value;
						}
					}
				}
				emitLog(
					state,
					"error",
					msg,
					Object.keys(scalarAttrs).length > 0 ? (scalarAttrs as Attributes) : undefined,
				);
			}
		},
		child(childCtx: Partial<LogContext> & { readonly attrs?: Attributes }): Logger {
			const convId = childCtx.conversationId ?? ctx.conversationId;
			const tId = childCtx.turnId ?? ctx.turnId;
			const sId = childCtx.spanId ?? ctx.spanId;
			const pId = childCtx.parentSpanId ?? ctx.parentSpanId;
			const newCtx: LogContext = {
				extensionId: ctx.extensionId,
				...(convId !== undefined ? { conversationId: convId } : {}),
				...(tId !== undefined ? { turnId: tId } : {}),
				...(sId !== undefined ? { spanId: sId } : {}),
				...(pId !== undefined ? { parentSpanId: pId } : {}),
			};
			const newAttrs = mergeAttributes(state.attrs, childCtx.attrs);
			return createLogger(newCtx, sink, deps, newAttrs);
		},
		span(name: string, attrs?: Attributes): Span {
			return makeSpan(name, attrs);
		},
	};

	return logger;
}
