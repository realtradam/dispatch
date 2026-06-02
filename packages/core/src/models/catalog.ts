import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * models.dev-backed model catalog. Resolves a model's MAXIMUM context window
 * (`limit.context`) dynamically from the public models.dev API, mirroring how
 * opencode determines per-model context limits — no hardcoded table.
 *
 * The catalog is fetched once, cached on disk with a short TTL, and reused. On
 * fetch failure we fall back to a stale-but-present cache so the lookup keeps
 * working offline. Lookups never throw: an unknown/unreachable model resolves
 * to `null`, which the UI renders as "max unknown".
 */

/** Shape of the slice of models.dev's `/api.json` we consume. */
interface ModelsDevModel {
	limit?: {
		context?: number;
		output?: number;
	};
}

interface ModelsDevProvider {
	id: string;
	models: Record<string, ModelsDevModel | undefined>;
}

type ModelsDevCatalog = Record<string, ModelsDevProvider | undefined>;

/** Where models.dev's API lives. Overridable for tests / private mirrors. */
const MODELS_URL = process.env.DISPATCH_MODELS_URL || "https://models.dev";

/** Disk cache path (reuses the repo's `/tmp/dispatch` convention). */
const CACHE_PATH = "/tmp/dispatch/models-dev.json";

/** How long a cached catalog stays fresh before we re-fetch. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Network timeout for the catalog fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * After a failed fetch we memoize the fallback for this long before retrying,
 * so a sustained outage doesn't make every lookup hang on a fresh timeout.
 */
const FETCH_PENALTY_MS = 60_000;

/**
 * Dispatch provider id → models.dev provider ids to search, in priority order.
 * We only support Claude-backed providers (per product scope). `anthropic` and
 * `opencode-anthropic` are both Claude; we try the first-party `anthropic`
 * catalog first, then the `opencode` gateway catalog as a fallback.
 */
const PROVIDER_MAP: Record<string, string[]> = {
	anthropic: ["anthropic", "opencode"],
	"opencode-anthropic": ["anthropic", "opencode"],
};

/** In-process memoized catalog promise (one fetch/parse per TTL window). */
let cached: { catalog: ModelsDevCatalog; fetchedAt: number } | null = null;
let inflight: Promise<ModelsDevCatalog> | null = null;

function readDiskCache(): { catalog: ModelsDevCatalog; mtimeMs: number } | null {
	try {
		const stat = statSync(CACHE_PATH);
		const text = readFileSync(CACHE_PATH, "utf-8");
		return { catalog: JSON.parse(text) as ModelsDevCatalog, mtimeMs: stat.mtimeMs };
	} catch {
		return null;
	}
}

function writeDiskCache(text: string): void {
	try {
		mkdirSync(dirname(CACHE_PATH), { recursive: true });
		// Write-then-rename so a concurrent reader never sees a half-written
		// file (rename is atomic on the same filesystem). The temp name is
		// process-scoped to avoid two writers clobbering each other's temp.
		const tmp = `${CACHE_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, text, "utf-8");
		renameSync(tmp, CACHE_PATH);
	} catch {
		// Best-effort: a read-only /tmp shouldn't break lookups.
	}
}

async function fetchCatalog(): Promise<ModelsDevCatalog> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`${MODELS_URL}/api.json`, { signal: controller.signal });
		if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
		const text = await res.text();
		const catalog = JSON.parse(text) as ModelsDevCatalog;
		writeDiskCache(text);
		return catalog;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Load the models.dev catalog, preferring in-process memo, then a fresh disk
 * cache, then a network fetch. On network failure, falls back to any stale
 * disk cache; if nothing is available, returns an empty catalog.
 */
export async function getModelsCatalog(): Promise<ModelsDevCatalog> {
	if (process.env.DISPATCH_DISABLE_MODELS_FETCH) {
		const disk = readDiskCache();
		return disk?.catalog ?? {};
	}

	const now = Date.now();
	if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.catalog;

	// Fresh disk cache satisfies the request without a network round-trip.
	const disk = readDiskCache();
	if (disk && now - disk.mtimeMs < CACHE_TTL_MS) {
		// Inherit the file's mtime as `fetchedAt` so loading a disk cache into
		// a fresh process doesn't reset its TTL (which would otherwise double
		// the worst-case staleness across process boundaries).
		cached = { catalog: disk.catalog, fetchedAt: disk.mtimeMs };
		return disk.catalog;
	}

	if (!inflight) {
		inflight = fetchCatalog()
			.then((catalog) => {
				cached = { catalog, fetchedAt: Date.now() };
				return catalog;
			})
			.catch((err) => {
				// Network failed — serve a stale cache if we have one.
				console.warn(
					`dispatch: failed to fetch models.dev catalog: ${err instanceof Error ? err.message : String(err)}`,
				);
				const fallback = disk?.catalog ?? ({} as ModelsDevCatalog);
				// Memoize the fallback with a short "penalty" TTL so a sustained
				// outage doesn't make every lookup hang on a fresh 10s timeout.
				// `fetchedAt` is backdated so the memo expires after FETCH_PENALTY_MS.
				cached = {
					catalog: fallback,
					fetchedAt: Date.now() - CACHE_TTL_MS + FETCH_PENALTY_MS,
				};
				return fallback;
			})
			.finally(() => {
				inflight = null;
			});
	}
	return inflight;
}

/**
 * Resolve a model's maximum context window (in tokens) for the given Dispatch
 * provider + model id. Returns `null` when the provider is unsupported, the
 * model is unknown, or the catalog is unavailable — callers should render that
 * as "max unknown" (no denominator / percentage).
 */
export async function resolveContextLimit(
	provider: string,
	modelId: string,
): Promise<number | null> {
	const candidates = PROVIDER_MAP[provider];
	if (!candidates || !modelId) return null;

	const catalog = await getModelsCatalog();
	for (const providerId of candidates) {
		const ctx = catalog[providerId]?.models?.[modelId]?.limit?.context;
		if (typeof ctx === "number" && ctx > 0) return ctx;
	}
	return null;
}

/** Test-only: reset the in-process memo so a test can re-exercise loading. */
export function __resetCatalogCacheForTests(): void {
	cached = null;
	inflight = null;
}
