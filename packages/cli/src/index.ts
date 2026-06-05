/**
 * Barrel export — the public surface of @dispatch/cli.
 *
 * Pure functions + http functions for consumers and tests.
 */

export { type ParsedCommand, parseArgs } from "./args.js";
export { formatCatalog } from "./catalog.js";
export { fetchModels, streamChat } from "./http.js";
export { buildChatRequest, composeMessage } from "./message.js";
export { type SplitResult, splitNdjsonLines } from "./ndjson.js";
export { renderEvent } from "./render.js";
