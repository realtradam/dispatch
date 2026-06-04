/**
 * Tool contract — what a tool conforms to and what the kernel calls.
 *
 * The kernel never finds or names a concrete tool; it receives them via
 * `runTurn` and dispatches by shape. A tool's `parameters` uses a structural
 * JSON-Schema-like type so the kernel stays dependency-light (no zod).
 * Extensions may use zod internally and convert to this shape.
 */

/**
 * Structural JSON Schema subset for tool parameter declarations.
 * The kernel does not validate against this — the provider serializes it for
 * the model, and the tool implementation validates its own input.
 * Using a structural type (not a library) keeps the kernel dependency-free.
 */
export interface ToolParameterSchema {
	readonly type: "object";
	readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean;
	readonly description?: string;
}

/** A single property within a tool's parameter schema. */
export interface JsonSchemaProperty {
	readonly type?: string;
	readonly description?: string;
	readonly enum?: readonly string[];
	readonly items?: JsonSchemaProperty;
	readonly properties?: Readonly<Record<string, JsonSchemaProperty>>;
	readonly required?: readonly string[];
	readonly default?: unknown;
}

/**
 * Context passed to a tool's `execute` method. The kernel constructs this per
 * call, attributing streaming output to the specific tool-call id so
 * concurrent tool output is never interleaved ambiguously.
 */
export interface ToolExecuteContext {
	/** Unique id of the tool-call this execution serves. */
	readonly toolCallId: string;

	/**
	 * Stream output from the tool. The kernel attributes every call to the
	 * tool-call id, so concurrent shell output from different tools is
	 * correctly separated.
	 */
	readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;

	/**
	 * Cancellation signal. An aborted turn sets this so in-flight tool work
	 * can clean up rather than leak.
	 */
	readonly signal: AbortSignal;
}

/**
 * The value a tool returns from execution. Content is a string for
 * provider-agnostic transport; `isError` flags failure so the model can
 * react without the kernel interpreting the content.
 */
export interface ToolResult {
	readonly content: string;
	readonly isError?: boolean;
}

/**
 * A tool-call as emitted by the provider and dispatched by the kernel.
 * The kernel matches `name` against registered tools and passes `input`
 * to the matched tool's `execute`.
 */
export interface ToolCall {
	readonly id: string;
	readonly name: string;
	readonly input: unknown;
}

/**
 * What a tool extension registers with the kernel via `host.defineTool`.
 * The kernel calls `execute` blindly by shape — it never knows which
 * concrete tools exist.
 */
export interface ToolContract {
	/** Unique name the model uses to invoke this tool. */
	readonly name: string;

	/** Human-readable description shown to the model. */
	readonly description: string;

	/** JSON-Schema-ish parameter declaration (structural, no library dep). */
	readonly parameters: ToolParameterSchema;

	/**
	 * Execute the tool with parsed input. The kernel provides a per-call
	 * context (cancellation, output streaming, attribution).
	 */
	readonly execute: (args: unknown, ctx: ToolExecuteContext) => Promise<ToolResult>;

	/**
	 * Whether this tool is safe to run concurrently with other tools.
	 * When `false`, the kernel serializes this tool's calls even when the
	 * dispatch policy allows parallelism. Defaults to `true` if omitted.
	 * This overrides the global setting downward only (never widens parallelism).
	 */
	readonly concurrencySafe?: boolean;
}
