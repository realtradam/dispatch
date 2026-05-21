import { getDatabase } from "../db/index.js";
import type { ClaudeCredentials } from "./claude.js";
import { existsSync, readFileSync } from "node:fs";

export interface StoredCredential {
	keyId: string;
	provider: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	subscriptionType: string | null;
	sourceFile: string | null;
	importedAt: number;
	updatedAt: number;
}

function parseCredentialsFile(raw: string): ClaudeCredentials | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

	const data = (parsed as Record<string, unknown>).claudeAiOauth ?? parsed;
	const creds = data as Record<string, unknown>;

	if (creds.mcpOAuth && !creds.accessToken) return null;

	if (
		typeof creds.accessToken !== "string" ||
		typeof creds.refreshToken !== "string" ||
		typeof creds.expiresAt !== "number"
	) {
		return null;
	}

	return {
		accessToken: creds.accessToken as string,
		refreshToken: creds.refreshToken as string,
		expiresAt: creds.expiresAt as number,
		subscriptionType: typeof creds.subscriptionType === "string" ? creds.subscriptionType : undefined,
	};
}

/**
 * Import credentials from a file into the database for a specific key.
 * Reads the credential file, parses it, and upserts into the credentials table.
 */
export function importCredentialsFromFile(
	keyId: string,
	provider: string,
	filePath: string,
): { success: boolean; error?: string } {
	if (!existsSync(filePath)) {
		return { success: false, error: `File not found: ${filePath}` };
	}

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8").trim();
	} catch (e) {
		return { success: false, error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
	}

	if (!raw) {
		return { success: false, error: "File is empty" };
	}

	const creds = parseCredentialsFile(raw);
	if (!creds) {
		return { success: false, error: "Invalid credentials format" };
	}

	const db = getDatabase();
	const now = Date.now();

	db.query(
		`INSERT INTO credentials (key_id, provider, access_token, refresh_token, expires_at, subscription_type, source_file, imported_at, updated_at)
		 VALUES ($keyId, $provider, $accessToken, $refreshToken, $expiresAt, $subscriptionType, $sourceFile, $now, $now)
		 ON CONFLICT(key_id) DO UPDATE SET
		   access_token = $accessToken,
		   refresh_token = $refreshToken,
		   expires_at = $expiresAt,
		   subscription_type = $subscriptionType,
		   source_file = $sourceFile,
		   updated_at = $now`,
	).run({
		$keyId: keyId,
		$provider: provider,
		$accessToken: creds.accessToken,
		$refreshToken: creds.refreshToken,
		$expiresAt: creds.expiresAt,
		$subscriptionType: creds.subscriptionType ?? null,
		$sourceFile: filePath,
		$now: now,
	});

	return { success: true };
}

/**
 * Get stored credentials for a specific key from the database.
 */
export function getStoredCredentials(keyId: string): StoredCredential | null {
	const db = getDatabase();
	const row = db.query(
		"SELECT key_id, provider, access_token, refresh_token, expires_at, subscription_type, source_file, imported_at, updated_at FROM credentials WHERE key_id = $keyId",
	).get({ $keyId: keyId }) as Record<string, unknown> | null;

	if (!row) return null;

	return {
		keyId: row.key_id as string,
		provider: row.provider as string,
		accessToken: row.access_token as string,
		refreshToken: row.refresh_token as string,
		expiresAt: row.expires_at as number,
		subscriptionType: row.subscription_type as string | null,
		sourceFile: row.source_file as string | null,
		importedAt: row.imported_at as number,
		updatedAt: row.updated_at as number,
	};
}

/**
 * Update tokens in the database after a refresh.
 */
export function updateStoredTokens(
	keyId: string,
	accessToken: string,
	refreshToken: string,
	expiresAt: number,
): void {
	const db = getDatabase();
	db.query(
		`UPDATE credentials SET access_token = $accessToken, refresh_token = $refreshToken, expires_at = $expiresAt, updated_at = $now WHERE key_id = $keyId`,
	).run({
		$keyId: keyId,
		$accessToken: accessToken,
		$refreshToken: refreshToken,
		$expiresAt: expiresAt,
		$now: Date.now(),
	});
}

/**
 * Delete stored credentials for a key.
 */
export function deleteStoredCredentials(keyId: string): void {
	const db = getDatabase();
	db.query("DELETE FROM credentials WHERE key_id = $keyId").run({ $keyId: keyId });
}

/**
 * List all keys that have imported credentials, with their status.
 */
export function listStoredCredentials(): StoredCredential[] {
	const db = getDatabase();
	const rows = db.query(
		"SELECT key_id, provider, access_token, refresh_token, expires_at, subscription_type, source_file, imported_at, updated_at FROM credentials ORDER BY key_id",
	).all() as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		keyId: row.key_id as string,
		provider: row.provider as string,
		accessToken: row.access_token as string,
		refreshToken: row.refresh_token as string,
		expiresAt: row.expires_at as number,
		subscriptionType: row.subscription_type as string | null,
		sourceFile: row.source_file as string | null,
		importedAt: row.imported_at as number,
		updatedAt: row.updated_at as number,
	}));
}
