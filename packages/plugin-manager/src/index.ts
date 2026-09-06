export type {
  PluginEngine,
  PluginScanResult,
  ReconciledScanBuckets,
  ScannedPluginEntry,
} from "./engine.js";
export { pluginEngineHandle } from "./engine.js";
export { extension, manifest } from "./extension.js";
export type { PluginOverrideKind, PluginOverrideRecord } from "./overrides.js";
export {
  decodeOverrideRecord,
  encodeOverrideRecord,
  PLUGIN_OVERRIDES_NAMESPACE,
} from "./overrides.js";
export type { DeriveListInput, LifecycleDecision, UnloadDecisionInput } from "./pure.js";
export {
  classifyReload,
  classifyUnload,
  computeUnloadCascade,
  deriveListView,
  deriveScanResponse,
  findLoadableEntry,
  overrideForUnload,
  toDisabledWithReasonRow,
  toDiscoveredRow,
  toLoadedRow,
  toMissingRow,
  toOverrideInfo,
} from "./pure.js";
export type {
  FrontendEntryResult,
  PluginManagerService,
  PluginManagerServiceDeps,
} from "./service.js";
export { createPluginManagerService } from "./service.js";
export { extensionsChanged, pluginManagerHandle } from "./service-handle.js";
