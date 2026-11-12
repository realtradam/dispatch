import type { StorageNamespace } from "@dispatch/kernel";
import {
  DEFAULT_SEARCH_BACKEND_ORDER,
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
 * the `web_search` tool's search mode. An ABSENT `backend` means "no explicit
 * selection" — automatic mode picks from {@link DEFAULT_SEARCH_BACKEND_ORDER}.
 * `"none"` is the explicit off state — search refuses cleanly while
 * scrape/crawl keep working.
 */
export interface SearchConfig {
  readonly backend?: string;
}

/** No explicit selection (automatic mode). */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {};

/**
 * Backend ids that were persisted in the past but no longer exist. A persisted
 * `backend` in this list is treated as absent (automatic mode) on load — the
 * production migration for the retired `"umans"` selection.
 */
export const RETIRED_SEARCH_BACKEND_IDS: readonly string[] = ["umans"];

/** Storage key for the (single, global) search config document. */
export const SEARCH_CONFIG_KEY = "config:global";

/** Why a config update was rejected. */
export type SearchConfigUpdateError = "unknown-backend";

/** Outcome of applying a config update against the live backend list. */
export type UpdateSearchConfigResult =
  | { readonly ok: true; readonly config: SearchConfig }
  | { readonly ok: false; readonly error: SearchConfigUpdateError };

/**
 * Pure: the effective backend id for a config against the live backend list.
 * An explicit `config.backend` is returned as-is (even if unregistered, even
 * `"none"`). Otherwise the first id of {@link DEFAULT_SEARCH_BACKEND_ORDER}
 * that is registered, else the first registered backend's id, else `"none"`.
 */
export function resolveEffectiveBackendId(
  config: SearchConfig,
  backends: readonly SearchBackend[],
): string {
  if (config.backend !== undefined) {
    return config.backend;
  }
  for (const id of DEFAULT_SEARCH_BACKEND_ORDER) {
    if (backends.some((backend) => backend.id === id)) {
      return id;
    }
  }
  const first = backends[0];
  return first?.id ?? SEARCH_BACKEND_NONE;
}

/**
 * Pure: the ACTIVE backend — the one whose id equals the effective id, else
 * `null` (the `"none"` off state / an unregistered selection). `null` is the
 * tool's clean search-disabled signal.
 */
export function resolveSelectedBackend(
  config: SearchConfig,
  backends: readonly SearchBackend[],
): SearchBackend | null {
  const id = resolveEffectiveBackendId(config, backends);
  return backends.find((backend) => backend.id === id) ?? null;
}

/**
 * Pure: the dropdown payload — every registered backend (`configured: true`),
 * sorted: ids in {@link DEFAULT_SEARCH_BACKEND_ORDER} first in that order, then
 * all others in registration order.
 */
export function availableBackends(
  backends: readonly SearchBackend[],
): readonly SearchBackendAvailability[] {
  const ordered: SearchBackend[] = [];
  for (const id of DEFAULT_SEARCH_BACKEND_ORDER) {
    const match = backends.find((backend) => backend.id === id);
    if (match !== undefined) {
      ordered.push(match);
    }
  }
  for (const backend of backends) {
    if (!DEFAULT_SEARCH_BACKEND_ORDER.includes(backend.id)) {
      ordered.push(backend);
    }
  }
  return ordered.map((backend) => ({
    id: backend.id,
    label: backend.label,
    configured: true,
  }));
}

/**
 * Pure: validate a partial update against the live backend list and apply it.
 * `"none"` or a registered id is accepted and becomes the explicit selection;
 * anything else is `unknown-backend`. An absent `backend` leaves `current`
 * unchanged.
 */
export function applyConfigUpdate(
  current: SearchConfig,
  update: UpdateSearchConfigRequest,
  backends: readonly SearchBackend[],
): UpdateSearchConfigResult {
  const backend = update.backend;
  if (backend === undefined) {
    return { ok: true, config: current };
  }
  if (typeof backend !== "string" || backend.trim().length === 0) {
    return { ok: false, error: "unknown-backend" };
  }
  if (backend === SEARCH_BACKEND_NONE) {
    return { ok: true, config: { backend } };
  }
  if (!backends.some((candidate) => candidate.id === backend)) {
    return { ok: false, error: "unknown-backend" };
  }
  return { ok: true, config: { backend } };
}

/**
 * Parse a persisted raw document into a `SearchConfig`. Garbage, an empty
 * backend, or a retired id (see {@link RETIRED_SEARCH_BACKEND_IDS}) becomes the
 * absent/automatic default.
 */
function parseConfig(raw: string | null): SearchConfig {
  if (raw === null) {
    return DEFAULT_SEARCH_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw) as { backend?: unknown };
    if (typeof parsed.backend === "string" && parsed.backend.length > 0) {
      if (RETIRED_SEARCH_BACKEND_IDS.includes(parsed.backend)) {
        return DEFAULT_SEARCH_CONFIG;
      }
      return { backend: parsed.backend };
    }
    return DEFAULT_SEARCH_CONFIG;
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
  /** `GET /search/config` payload: effective selection + availability. */
  readonly getConfig: () => Promise<SearchBackendConfigResponse>;
  /**
   * Validate + persist a partial update. Rejections are VALUES (not throws):
   * `unknown-backend` → HTTP 400.
   */
  readonly updateConfig: (update: UpdateSearchConfigRequest) => Promise<UpdateSearchConfigResult>;
  /** The current dropdown availability list (every registered backend). */
  readonly availableBackends: () => readonly SearchBackendAvailability[];
  /**
   * Resolve the ACTIVE `SearchBackend` for the tool's search mode. `null`
   * (the `"none"` off state / an unregistered selection) → search disabled.
   */
  readonly resolveBackend: () => Promise<SearchBackend | null>;
}

export interface SearchConfigServiceDeps {
  readonly storage: StorageNamespace;
  /**
   * The live registered backends. Called on EVERY operation (never cached) —
   * backends register and unregister at runtime.
   */
  readonly listBackends: () => readonly SearchBackend[];
}

export function createSearchConfigService(deps: SearchConfigServiceDeps): SearchConfigService {
  const store = createSearchConfigStore(deps.storage);
  const listBackends = deps.listBackends;
  return {
    async getConfig(): Promise<SearchBackendConfigResponse> {
      const config = await store.get();
      const backends = listBackends();
      return {
        backend: resolveEffectiveBackendId(config, backends),
        available: availableBackends(backends),
      };
    },
    async updateConfig(update: UpdateSearchConfigRequest): Promise<UpdateSearchConfigResult> {
      const current = await store.get();
      const result = applyConfigUpdate(current, update, listBackends());
      if (!result.ok) {
        return result;
      }
      await store.set(result.config);
      return result;
    },
    availableBackends(): readonly SearchBackendAvailability[] {
      return availableBackends(listBackends());
    },
    async resolveBackend(): Promise<SearchBackend | null> {
      return resolveSelectedBackend(await store.get(), listBackends());
    },
  };
}
