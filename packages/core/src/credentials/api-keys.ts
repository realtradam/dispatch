import { getDatabase } from "../db/index.js";

export interface StoredApiKey {
	keyId: string;
	provider: string;
	apiKey: string;
	importedAt: number;
	updatedAt: number;
}

/**
 * Store or update an API key in the database.
 */
export function setApiKey(keyId: string, provider: string, apiKey: string): void {
	const db = getDatabase();
	const now = Date.now();
	db.query(
		`INSERT INTO api_keys (key_id, provider, api_key, imported_at, updated_at)
		 VALUES ($keyId, $provider, $apiKey, $now, $now)
		 ON CONFLICT(key_id) DO UPDATE SET
		   api_key = $apiKey,
		   updated_at = $now`,
	).run({
		$keyId: keyId,
		$provider: provider,
		$apiKey: apiKey,
		$now: now,
	});
}

/**
 * Get a stored API key by key ID. Returns the key string or null.
 */
export function getApiKey(keyId: string): string | null {
	const db = getDatabase();
	const row = db
		.query("SELECT api_key FROM api_keys WHERE key_id = $keyId")
		.get({ $keyId: keyId }) as { api_key: string } | null;
	return row?.api_key ?? null;
}

/**
 * Resolve an API key from the database, with env var fallback.
 * Pass the env var name (e.g. "GOOGLE_API_KEY") to check process.env as well.
 */
export function resolveApiKey(keyId: string, envVar?: string): string | null {
	const dbKey = getApiKey(keyId);
	if (dbKey) return dbKey;
	if (envVar) return process.env[envVar] ?? null;
	return null;
}

/**
 * Delete a stored API key.
 */
export function deleteApiKey(keyId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM api_keys WHERE key_id = $keyId").run({ $keyId: keyId });
}

/**
 * List all stored API keys with metadata (key value excluded for security).
 */
export function listApiKeys(): Array<{
	keyId: string;
	provider: string;
	importedAt: number;
	updatedAt: number;
}> {
	const db = getDatabase();
	const rows = db
		.query("SELECT key_id, provider, imported_at, updated_at FROM api_keys ORDER BY key_id")
		.all() as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		keyId: row.key_id as string,
		provider: row.provider as string,
		importedAt: row.imported_at as number,
		updatedAt: row.updated_at as number,
	}));
}
