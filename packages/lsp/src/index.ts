export type {
	ClientDeps,
	FileWatcher,
	FileWatcherHandle,
	FsAccess,
	SpawnedProcess,
	SpawnProcess,
} from "./client.js";
export { LanguageServerClient } from "./client.js";
export type { LspJsonConfig, OpencodeJsonConfig, ResolvedServer, ServerConfig } from "./config.js";
export { resolveServers } from "./config.js";
export type {
	Diagnostic,
	DocumentDiagnosticReport,
	PublishDiagnosticsParams,
} from "./diagnostics.js";
export { DiagnosticsStore } from "./diagnostics.js";
export { extension, lspServiceHandle } from "./extension.js";
export { encode, FrameDecoder } from "./framing.js";
export { languageId } from "./language.js";
export type { Logger, ManagerDeps } from "./manager.js";
export { LspManager } from "./manager.js";
export { findRoot } from "./root.js";
export type { JsonRpcMessage, NotificationHandler, RequestHandler, WriteFn } from "./rpc.js";
export { JsonRpcConnection } from "./rpc.js";
export { createLspTool } from "./tool.js";
export type { LspServerState, LspServerStatus, LspService } from "./types.js";
export type { FileChangeTypeValue, FileSystemWatcher, Registration } from "./watched-files.js";
export { FileChangeType, globMatch, WatchedFilesRegistry } from "./watched-files.js";
