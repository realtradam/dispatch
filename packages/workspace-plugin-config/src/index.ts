export { activate, extension, manifest } from "./extension.js";
export {
  type CatalogPlugin,
  DEFAULT_WORKSPACE_ID,
  decodeStateRecord,
  encodeStateRecord,
  inheritState,
  isPluginUsable,
  MATERIALIZED_MARKER_PLUGIN_ID,
  type MaterializationWrite,
  materializedMarkerKey,
  planMaterialization,
  type SetStateValidation,
  storageKey,
  validateSetState,
  WORKSPACE_PLUGIN_CONFIG_NAMESPACE,
  type WorkspacePluginState,
} from "./pure.js";
export {
  createWorkspacePluginConfigService,
  type SetStateRefusalReason,
  type SetWorkspaceStateRequest,
  type SetWorkspaceStateResult,
  type WorkspacePluginConfigDeps,
  type WorkspacePluginConfigService,
} from "./service.js";
export { workspacePluginConfigHandle } from "./service-handle.js";
export { usablePluginsInWorkspace } from "./usable.js";
