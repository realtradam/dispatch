export {
  applyConfigUpdate,
  availableBackends,
  createSearchConfigService,
  DEFAULT_SEARCH_CONFIG,
  RETIRED_SEARCH_BACKEND_IDS,
  resolveEffectiveBackendId,
  resolveSelectedBackend,
  SEARCH_CONFIG_KEY,
  type SearchConfig,
  type SearchConfigService,
  type SearchConfigServiceDeps,
  type SearchConfigUpdateError,
  type UpdateSearchConfigResult,
} from "./search-config.js";
export { searchConfigServiceHandle } from "./service-handle.js";
