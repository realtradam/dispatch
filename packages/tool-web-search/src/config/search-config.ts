import type { StorageNamespace } from "@dispatch/kernel";
import {
  DEFAULT_SEARCH_BACKEND,
  SEARCH_BACKEND_NONE,
  type SearchBackend,
} from "@dispatch/search-backend-contract";
import type {
  SearchBackendAvailability,
  SearchBackendConfigResponse,
  UpdateSearchConfigRequest,
} from "@dispatch/transport-contract";

/**
 * The GLOBAL search-backend selection state (`GET/PUT /search/config`).
 * One document for the whole backend (not per-workspace): which engine backs
 * the `web_search` tool's search mode. `"none"` is the explicit off state —
 * search refuses cleanly while scrape/crawl keep working.
 */
export interface SearchConfig {
  readonly backend: string;
}

/** The zero-migration default: today's Firecrawl-backed behavior. */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = { backend: DEFAULT_SEARCH_BACKEND };

/** Storage key for the (single, global) search config document. */
export const SEARCH_CONFIG_KEY = "config:global";

/** One registry entry: a backend plus its availability gate. */
export interface RegisteredSearchBackend {
  readonly backend: SearchBackend;
  readonly configured: boolean;
}

/** Registry the service resolves selections against (extension-wired). */
export type SearchBackendRegistry = readonly RegisteredSearchBackend[];

/** Why a config update was rejected. */
export type SearchConfigUpdateError = "unknown-backend" | "not-configured";

/** Outcome of applying a config update against the live registry. */
export type UpdateSearchConfigResult =
  | { readonly ok: true; readonly config: SearchConfig }
  | { readonly ok: false; readonly error: SearchConfigUpdateError };

/**
 * Pure: validate a partial update against the AVAILABLE backend list and
 * apply it. Valid ids = every registered backend's id (configured or not —
 * selecting a registered-but-unconfigured backend is a `not-configured`
 * rejection, not `unknown`), plus the explicit `"none"` off state. Absent
 * `backend` leaves the current value.
 */
export function applyConfigUpdate(
  current: SearchConfig,
  update: UpdateSearchConfigRequest,
  registry: SearchBackendRegistry,
): UpdateSearchConfigResult {
  const backend = update.backend;
  if (backend === undefined) {
    return { ok: true, config: current };
  }
  if (typeof backend !== "string" || backend.trim().length === 0) {
    return { ok: false, error: "unknown-backend" };
  }
  if (backend === SEARCH_BACKEND_NONE) {
    return { ok: true, config: { backend: SEARCH_BACKEND_NONE } };
  }
  const entry = registry.find((r) => r.backend.id === backend);
  if (entry === undefined) {
    return { ok: false, error: "unknown-backend" };
  }
  if (!entry.configured) {
    return { ok: false, error: "not-configured" };
  }
  return { ok: true, config: { backend } };
}

/**
 * Pure: the dropdown payload — every registered backend with its
 * availability (configured = the env gate), plus the currently selected id.
 */
export function availableBackends(
  registry: SearchBackendRegistry,
): readonly SearchBackendAvailability[] {
  return registry.map((r) => ({
    id: r.backend.id,
    label: r.backend.label,
    configured: r.configured,
  }));
}

/**
 * Pure: resolve the persisted selection to the ACTIVE backend — `null` when
 * search is off (`"none"`) or the selected id is unknown/unconfigured (a
 * persisted id whose backend lost its env key, say). `null` is the tool's
 * clean search-disabled signal.
 */
export function resolveSelectedBackend(
  config: SearchConfig,
  registry: SearchBackendRegistry,
): SearchBackend | null {
  if (config.backend === SEARCH_BACKEND_NONE) {
    return null;
  }
  const entry = registry.find((r) => r.backend.id === config.backend);
  if (entry === undefined || !entry.configured) {
    return null;
  }
  return entry.backend;
}

/** Parse a persisted raw document into a `SearchConfig` (default on garbage). */
function parseConfig(raw: string | null): SearchConfig {
  if (raw === null) {
    return DEFAULT_SEARCH_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SearchConfig>;
    return typeof parsed.backend === "string" && parsed.backend.length > 0
      ? { backend: parsed.backend }
      : DEFAULT_SEARCH_CONFIG;
  } catch {
    return DEFAULT_SEARCH_CONFIG;
  }
}

export interface SearchConfigStore {
  /** The persisted (or default) global config. */
  readonly get: () => Promise<SearchConfig>;
  /** Persist a config document verbatim (already validated by the service). */
  readonly set: (config: SearchConfig) => Promise<void>;
}

/** Storage-backed global search config store (single fixed key). */
export function createSearchConfigStore(storage: StorageNamespace): SearchConfigStore {
  return {
    async get(): Promise<SearchConfig> {
      return parseConfig(await storage.get(SEARCH_CONFIG_KEY));
    },
    async set(config: SearchConfig): Promise<void> {
      await storage.set(SEARCH_CONFIG_KEY, JSON.stringify(config));
    },
  };
}

/**
 * The search-config service surface — what transport-http consumes and what
 * the tool's backend resolver reads.
 */
export interface SearchConfigService {
  /** `GET /search/config` payload: selection + availability. */
  readonly getConfig: () => Promise<SearchBackendConfigResponse>;
  /**
   * Validate + persist a partial update. Rejections are VALUES (not throws):
   * `unknown-backend` → HTTP 400, `not-configured` → HTTP 400.
   */
  readonly updateConfig: (update: UpdateSearchConfigRequest) => Promise<UpdateSearchConfigResult>;
  /** The current dropdown availability list (registered ∧ configured gate). */
  readonly availableBackends: () => readonly SearchBackendAvailability[];
  /**
   * Resolve the ACTIVE `SearchBackend` for the tool's search mode. `null`
   * (the `"none"` off state / unknown / unconfigured selection) → search
   * disabled.
   */
  readonly resolveBackend: () => Promise<SearchBackend | null>;
}

export interface SearchConfigServiceDeps {
  readonly storage: StorageNamespace;
  /** The registered backends + their availability gates (extension-wired). */
  readonly registry: SearchBackendRegistry;
}

export function createSearchConfigService(deps: SearchConfigServiceDeps): SearchConfigService {
  const store = createSearchConfigStore(deps.storage);
  const registry = deps.registry;
  return {
    async getConfig(): Promise<SearchBackendConfigResponse> {
      const config = await store.get();
      return { backend: config.backend, available: availableBackends(registry) };
    },
    async updateConfig(update: UpdateSearchConfigRequest): Promise<UpdateSearchConfigResult> {
      const current = await store.get();
      const result = applyConfigUpdate(current, update, registry);
      if (!result.ok) {
        return result;
      }
      await store.set(result.config);
      return result;
    },
    availableBackends(): readonly SearchBackendAvailability[] {
      return availableBackends(registry);
    },
    async resolveBackend(): Promise<SearchBackend | null> {
      return resolveSelectedBackend(await store.get(), registry);
    },
  };
}
