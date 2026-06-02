// LSP (Language Server Protocol) integration.
//
// Config-driven only: servers are declared in `dispatch.toml`'s `[lsp.<id>]`
// block (see `LspServerConfig` in `../types`). There is no builtin server
// registry and no auto-download. The primary model-facing surface is
// diagnostics-on-write (the host passes a write hook that calls `touchFile` +
// `report`); an on-demand `lsp` tool exposes hover/definition/references too.

export {
	createLspClient,
	type Diagnostic,
	type LspClient,
	type LspServerHandle,
} from "./client.js";
export { pretty, report } from "./diagnostic.js";
export { LANGUAGE_EXTENSIONS, languageIdForExtension } from "./language.js";
export { LspManager } from "./manager.js";
export { type ResolvedLspServer, resolveServersFromConfig } from "./server.js";
