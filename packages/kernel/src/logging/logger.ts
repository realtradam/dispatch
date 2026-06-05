/**
 * Logger implementation — pure record-builder over an injected LogSink.
 *
 * All I/O goes through the sink. `{ now, newId }` are injected for
 * deterministic tests (P2). No ambient state (P3).
 */

import type {
	Attributes,
	ErrorAttributes,
	Level,
	LogContext,
	LogDeps,
	Logger,
	LogLineRecord,
	LogSink,
	Span,
	SpanCloseRecord,
	SpanLink,
	SpanOpenRecord,
	SpanStatus,
} from "../contracts/logging.js";

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
	body?: string,
	parentSpanId?: string,
): SpanOpenRecord {
	const base = {
		kind: "span-open" as const,
		spanId,
		name,
		timestamp: state.deps.now(),
		extensionId: state.ctx.extensionId,
	};
	const merged = mergeAttributes(state.attrs, attrs);
	const effectiveParent = parentSpanId ?? state.ctx.parentSpanId;
	return {
		...base,
		...(state.ctx.conversationId !== undefined ? { conversationId: state.ctx.conversationId } : {}),
		...(state.ctx.turnId !== undefined ? { turnId: state.ctx.turnId } : {}),
		...(effectiveParent !== undefined ? { parentSpanId: effectiveParent } : {}),
		...(merged !== undefined ? { attributes: merged } : {}),
		...(body !== undefined ? { body } : {}),
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

	function makeSpan(
		name: string,
		spanAttrs?: Attributes,
		parentSpanId?: string,
		body?: string,
	): Span {
		const spanId = deps.newId();
		const mergedParent = parentSpanId ?? state.ctx.spanId;
		const spanCtx: LogContext = {
			extensionId: ctx.extensionId,
			...(ctx.conversationId !== undefined ? { conversationId: ctx.conversationId } : {}),
			...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
			spanId,
			...(mergedParent !== undefined ? { parentSpanId: mergedParent } : {}),
		};

		const openRecord = buildSpanOpen(state, name, spanId, spanAttrs, body, mergedParent);
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
			child(childName: string, childAttrs?: Attributes, childBody?: string): Span {
				return makeSpan(childName, childAttrs, spanId, childBody);
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
					...(outcome?.body !== undefined ? { body: outcome.body } : {}),
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
		span(name: string, attrs?: Attributes, body?: string): Span {
			return makeSpan(name, attrs, undefined, body);
		},
	};

	return logger;
}
