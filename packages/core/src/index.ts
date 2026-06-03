// @dispatch/core — Agent runtime, LLM integration, tools

// Agent & LLM
export { Agent } from "./agent/agent.js";
export {
	deleteAgent,
	expandAgentToolNames,
	GLOBAL_AGENTS_DIR,
	getAgentDirPaths,
	getAgentDirs,
	getProjectAgentsDir,
	loadAgent,
	loadAgents,
	saveAgent,
} from "./agents/index.js";
// Chunk helpers
export {
	appendEventToChunks,
	applySystemEvent,
	type IdentifiedMessage,
	type SystemEventLike,
} from "./chunks/append.js";
// Compaction
export {
	buildCompactionPrompt,
	buildCompactionRequest,
	buildSummaryTurnText,
	type CompactionRequest,
	DEFAULT_TAIL_TURNS,
	extractPreviousSummary,
	type HeadTailSelection,
	renderTranscript,
	SUMMARY_MARKER,
	SUMMARY_TEMPLATE,
	selectHeadTail,
	TOOL_OUTPUT_MAX_CHARS,
} from "./compaction/index.js";
// Config
export {
	configToRuleset,
	createConfigWatcher,
	getGlobalConfigPath,
	loadConfig,
	loadGlobalConfig,
	mergeConfigs,
	validateConfig,
} from "./config/index.js";
// Credentials
export * from "./credentials/index.js";
export {
	appendChunks,
	clearChunksForTab,
	explodeTurn,
	explodeUserText,
	getChunksForTab,
	getMessagesForTab,
	getTotalChunkCount,
	getUsageStatsForTab,
	groupRowsToMessages,
	type MessageRow,
	rekeyChunks,
} from "./db/chunks.js";
// Database
export { closeDatabase, getDatabase, getDatabasePath } from "./db/index.js";
export { deleteSetting, getSetting, setSetting } from "./db/settings.js";
// Tabs & Messages
export {
	archiveTab,
	createTab,
	getTab,
	listOpenTabs,
	MIN_TAB_PREFIX_LENGTH,
	type ResolveTabPrefixResult,
	resolveTabPrefix,
	shortestUniquePrefix,
	type TabRow,
	updateTabModel,
	updateTabPositions,
	updateTabStatus,
	updateTabTitle,
} from "./db/tabs.js";
export {
	debugVerbosity,
	isDebugEnabled,
	logAgentLoop,
	logStepLifecycle,
	logStreamEvent,
} from "./llm/debug-logger.js";
export { createProvider } from "./llm/provider.js";
// LSP (Language Server Protocol)
export {
	createLspClient,
	type Diagnostic as LspDiagnostic,
	type LspClient,
	LspManager,
	type LspServerHandle,
	pretty as prettyDiagnostic,
	type ResolvedLspServer,
	report as reportDiagnostics,
	resolveServersFromConfig,
} from "./lsp/index.js";
// Models
export {
	ACCEPTED_ATTACHMENT_MEDIA_TYPES,
	ACCEPTED_IMAGE_MEDIA_TYPES,
	ACCEPTED_PDF_MEDIA_TYPE,
	type AttachmentValidationError,
	type AttachmentValidationResult,
	base64ByteLength,
	getModelsCatalog,
	hasAttachments,
	isAcceptedAttachmentMediaType,
	isImageMediaType,
	isPdfMediaType,
	MAX_ATTACHMENTS,
	MAX_IMAGE_BYTES,
	MAX_PDF_BYTES,
	MAX_TOTAL_ATTACHMENT_BYTES,
	type ModelInputCapabilities,
	ModelRegistry,
	resolveContextLimit,
	resolveModelCapabilities,
	validateUserContent,
} from "./models/index.js";
// Notifications (ntfy.sh)
export * from "./notifications/index.js";
export * from "./permission/index.js";
// Skills
export {
	createSkillsWatcher,
	getSkillByName,
	loadSkills,
	parseSkillFile,
	resolveSkillsForAgent,
} from "./skills/index.js";
export { prefix as bashArityPrefix } from "./tools/bash-arity.js";
// Tools
export { createKeyUsageTool, type KeyUsageCallbacks } from "./tools/key-usage.js";
export { createListFilesTool } from "./tools/list-files.js";
export { createLspTool, type LspToolContext } from "./tools/lsp.js";
export { createReadFileTool } from "./tools/read-file.js";
export { createReadFileSliceTool } from "./tools/read-file-slice.js";
export { createReadTabTool, type ReadTabCallbacks } from "./tools/read-tab.js";
export { createToolRegistry } from "./tools/registry.js";
export { createRetrieveTool, type RetrieveCallbacks } from "./tools/retrieve.js";
export { BackgroundShellStore, createRunShellTool } from "./tools/run-shell.js";
export { createSearchCodeTool } from "./tools/search-code.js";
export {
	createSendToTabTool,
	type ResolvedTabRef,
	type SendToTabCallbacks,
	type TabResolution,
} from "./tools/send-to-tab.js";
export { analyzeCommand } from "./tools/shell-analyze.js";
export {
	type AvailableAgent,
	createSummonTool,
	type SummonCallbacks,
	toAvailableSubagents,
	toAvailableUserAgents,
} from "./tools/summon.js";
export { createTaskListTool, TaskList, TODO_DESCRIPTION } from "./tools/task-list.js";
export { clearSpillForTab } from "./tools/truncate.js";
export { createWebSearchTool } from "./tools/web-search.js";
export { type AfterWriteHook, createWriteFileTool } from "./tools/write-file.js";
export {
	BackgroundTranscriptStore,
	createYoutubeTranscribeTool,
} from "./tools/youtube-transcribe.js";
// Types & Permissions
export * from "./types/index.js";
