import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getDatabase } from "../db/index.js";
import { getAnthropicBetas } from "./anthropic-betas.js";
import { getStoredCredentials, listStoredCredentials, updateStoredTokens } from "./store.js";

// Re-exported for backward compatibility — `getAnthropicBetas` historically
// lived here and is surfaced through `credentials/index.ts`. The definition
// now lives in the dependency-free `anthropic-betas.ts` module.
export { getAnthropicBetas };

export interface ClaudeCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	subscriptionType?: string;
}

export interface ClaudeAccount {
	id: string;
	label: string;
	source: string;
	credentials: ClaudeCredentials;
}

const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CREDENTIAL_CACHE_TTL_MS = 30_000;

const CREDENTIALS_DIR = join(homedir(), ".claude");
const PRIMARY_CREDENTIALS_FILE = join(CREDENTIALS_DIR, ".credentials.json");

const accountCacheMap = new Map<string, { creds: ClaudeCredentials; cachedAt: number }>();

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

	if (
		(creds as Record<string, unknown>).mcpOAuth &&
		!(creds as Record<string, unknown>).accessToken
	) {
		return null;
	}

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
		subscriptionType:
			typeof creds.subscriptionType === "string" ? creds.subscriptionType : undefined,
	};
}

function readCredentialsFile(filePath: string): ClaudeCredentials | null {
	try {
		if (!existsSync(filePath)) return null;
		const raw = readFileSync(filePath, "utf-8").trim();
		if (!raw) return null;
		return parseCredentialsFile(raw);
	} catch {
		return null;
	}
}

function writeCredentialsFile(filePath: string, creds: ClaudeCredentials): void {
	let existing: Record<string, unknown> = {};
	try {
		if (existsSync(filePath)) {
			const raw = readFileSync(filePath, "utf-8").trim();
			if (raw) {
				existing = JSON.parse(raw);
			}
		}
	} catch {
		existing = {};
	}

	const hasWrapper = "claudeAiOauth" in existing;
	const target = hasWrapper ? (existing.claudeAiOauth as Record<string, unknown>) : existing;
	target.accessToken = creds.accessToken;
	target.refreshToken = creds.refreshToken;
	target.expiresAt = creds.expiresAt;
	if (creds.subscriptionType) {
		target.subscriptionType = creds.subscriptionType;
	}

	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(filePath, JSON.stringify(existing, null, 2), { encoding: "utf-8", mode: 0o600 });
	if (process.platform !== "win32") {
		chmodSync(filePath, 0o600);
	}
}

async function refreshViaOAuth(refreshToken: string): Promise<ClaudeCredentials | null> {
	const body = new URLSearchParams({
		grant_type: "refresh_token",
		client_id: OAUTH_CLIENT_ID,
		refresh_token: refreshToken,
	});

	try {
		const response = await fetch(OAUTH_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
		});

		if (!response.ok) {
			return null;
		}

		const data = (await response.json()) as Record<string, unknown>;
		if (!data.access_token || typeof data.access_token !== "string") {
			return null;
		}

		return {
			accessToken: data.access_token as string,
			refreshToken: (data.refresh_token as string) ?? refreshToken,
			expiresAt: Date.now() + ((data.expires_in as number) ?? 36_000) * 1000,
			subscriptionType:
				typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
		};
	} catch {
		return null;
	}
}

function buildAccountLabels(accounts: ClaudeAccount[]): void {
	for (const acct of accounts) {
		acct.label = acct.credentials.subscriptionType
			? `Claude ${acct.credentials.subscriptionType.charAt(0).toUpperCase() + acct.credentials.subscriptionType.slice(1)}`
			: "Claude";
	}
}

/**
 * Load Claude accounts from the SQLite database.
 * Returns accounts for all stored anthropic credentials.
 * This is the preferred path — file-based discovery is the fallback.
 */
export function getClaudeAccountsFromDB(): ClaudeAccount[] {
	const stored = listStoredCredentials();
	const accounts: ClaudeAccount[] = [];

	for (const cred of stored) {
		if (cred.provider !== "anthropic") continue;
		accounts.push({
			id: cred.keyId,
			label: "",
			source: `db:${cred.keyId}`,
			credentials: {
				accessToken: cred.accessToken,
				refreshToken: cred.refreshToken,
				expiresAt: cred.expiresAt,
				subscriptionType: cred.subscriptionType ?? undefined,
			},
		});
	}

	buildAccountLabels(accounts);
	return accounts;
}

export function discoverClaudeAccounts(): ClaudeAccount[] {
	const accounts: ClaudeAccount[] = [];

	if (!existsSync(CREDENTIALS_DIR)) {
		return accounts;
	}

	const primaryCreds = readCredentialsFile(PRIMARY_CREDENTIALS_FILE);
	if (primaryCreds) {
		accounts.push({
			id: "claude-default",
			label: "",
			source: PRIMARY_CREDENTIALS_FILE,
			credentials: primaryCreds,
		});
	}

	try {
		const files = readdirSync(CREDENTIALS_DIR);
		const credFiles = files.filter(
			(f) => f.startsWith(".credentials") && f.endsWith(".json") && f !== ".credentials.json",
		);
		for (const file of credFiles) {
			const filePath = join(CREDENTIALS_DIR, file);
			const creds = readCredentialsFile(filePath);
			if (creds) {
				const id = basename(file, ".json").replace(/^\.credentials/, "claude") || `claude-${file}`;
				accounts.push({
					id,
					label: "",
					source: filePath,
					credentials: creds,
				});
			}
		}
	} catch {
		// ignore
	}

	buildAccountLabels(accounts);
	return accounts;
}

export function refreshAccountCredentials(account: ClaudeAccount): ClaudeCredentials | null {
	const cached = accountCacheMap.get(account.id);
	const now = Date.now();
	if (
		cached &&
		now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
		cached.creds.expiresAt > now + 60_000
	) {
		return cached.creds;
	}

	// Re-read credentials: from DB for DB-backed accounts, from file otherwise
	if (account.source.startsWith("db:")) {
		const stored = getStoredCredentials(account.id);
		if (stored) {
			account.credentials = {
				accessToken: stored.accessToken,
				refreshToken: stored.refreshToken,
				expiresAt: stored.expiresAt,
				subscriptionType: stored.subscriptionType ?? undefined,
			};
		}
	} else {
		const onDisk = readCredentialsFile(account.source);
		if (onDisk) {
			account.credentials = onDisk;
		}
	}

	if (account.credentials.expiresAt > now + 60_000) {
		accountCacheMap.set(account.id, { creds: account.credentials, cachedAt: now });
		return account.credentials;
	}

	// Try OAuth refresh
	if (account.credentials.refreshToken) {
		// Synchronous refresh not available in this context, but the async version will be used
		// by getCredentialsForAccount below
		return null;
	}

	return null;
}

export async function refreshAccountCredentialsAsync(
	account: ClaudeAccount,
): Promise<ClaudeCredentials | null> {
	const cached = accountCacheMap.get(account.id);
	const now = Date.now();
	if (
		cached &&
		now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
		cached.creds.expiresAt > now + 60_000
	) {
		return cached.creds;
	}

	// Re-read credentials: from DB for DB-backed accounts, from file otherwise
	if (account.source.startsWith("db:")) {
		const stored = getStoredCredentials(account.id);
		if (stored) {
			account.credentials = {
				accessToken: stored.accessToken,
				refreshToken: stored.refreshToken,
				expiresAt: stored.expiresAt,
				subscriptionType: stored.subscriptionType ?? undefined,
			};
		}
	} else {
		const onDisk = readCredentialsFile(account.source);
		if (onDisk) {
			account.credentials = onDisk;
		}
	}

	if (account.credentials.expiresAt > now + 60_000) {
		accountCacheMap.set(account.id, { creds: account.credentials, cachedAt: now });
		return account.credentials;
	}

	// Try OAuth refresh
	if (account.credentials.refreshToken) {
		const refreshed = await refreshViaOAuth(account.credentials.refreshToken);
		if (refreshed && refreshed.expiresAt > now + 60_000) {
			account.credentials = refreshed;
			// Update DB if this is a DB-backed account, otherwise write to file
			if (account.source.startsWith("db:")) {
				updateStoredTokens(
					account.id,
					refreshed.accessToken,
					refreshed.refreshToken,
					refreshed.expiresAt,
				);
			} else {
				writeCredentialsFile(account.source, refreshed);
			}
			accountCacheMap.set(account.id, { creds: refreshed, cachedAt: now });
			return refreshed;
		}
	}

	return null;
}

// ─── Billing Header Computation ────────────────────────────────

const BILLING_SALT = "59cf53e54c78";
const CC_VERSION = "2.1.112";

function extractFirstUserMessageText(messages: Array<{ role: string; content: string }>): string {
	const userMsg = messages.find((m) => m.role === "user");
	if (!userMsg) return "";
	if (typeof userMsg.content === "string") return userMsg.content;
	return "";
}

function computeCch(messageText: string): string {
	return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}

function computeVersionSuffix(messageText: string, version: string): string {
	const sampled = [4, 7, 20].map((i) => (i < messageText.length ? messageText[i] : "0")).join("");
	const input = `${BILLING_SALT}${sampled}${version}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

export function buildBillingHeaderValue(
	messages: Array<{ role: string; content: string }>,
): string {
	const text = extractFirstUserMessageText(messages);
	const version = process.env.ANTHROPIC_CLI_VERSION ?? CC_VERSION;
	const suffix = computeVersionSuffix(text, version);
	const cch = computeCch(text);
	return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

export const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Build the request body for a Claude "wake" probe — a tiny, cheap message
 * whose only purpose is to keep the subscription's rate-limit window warm.
 *
 * This MUST mirror the shape of a genuine Claude Code CLI request, because
 * Anthropic validates the `system[]` array on OAuth (Pro/Max) -authenticated,
 * Claude-Code-billed requests. A bare `{ model, messages }` body (no system
 * identity) is rejected (401/403) — which is exactly how the old probe silently
 * failed. The valid shape is:
 *
 *   system: [
 *     { type: "text", text: "x-anthropic-billing-header: ..." },  // billing, no cache_control
 *     { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
 *   ]
 *   messages: [ { role: "user", content: "hi" } ]
 *
 * Mirrors the runtime `transformClaudeOAuthBody` output for a single short user
 * turn. Pure: deterministic given its inputs (the billing header samples only
 * the user text), so it can be unit-tested without touching the network.
 */
export function buildWakeProbeBody(model: string): {
	model: string;
	max_tokens: number;
	system: Array<{ type: "text"; text: string }>;
	messages: Array<{ role: "user"; content: string }>;
} {
	const messages = [{ role: "user" as const, content: "hi" }];
	return {
		model,
		max_tokens: 16,
		system: [
			{ type: "text", text: buildBillingHeaderValue(messages) },
			{ type: "text", text: SYSTEM_IDENTITY },
		],
		messages,
	};
}

// ─── Anthropic Request Headers ────────────────────────────────

export function getAnthropicHeaders(accessToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${accessToken}`,
		"anthropic-version": "2023-06-01",
		"anthropic-beta": getAnthropicBetas().join(","),
		"anthropic-dangerous-direct-browser-access": "true",
		"x-app": "cli",
		"user-agent": `claude-cli/${CC_VERSION} (external, sdk-cli)`,
	};
}

// ─── Usage Tracking ───────────────────────────────────────────

export interface ClaudeUsageBucket {
	utilization?: number;
	resetsAt?: number;
}

export interface ClaudeUsageReport {
	fiveHour?: ClaudeUsageBucket;
	sevenDay?: ClaudeUsageBucket;
	sevenDayOpus?: ClaudeUsageBucket;
	sevenDaySonnet?: ClaudeUsageBucket;
	accountId?: string;
	email?: string;
	orgId?: string;
}

// ─── Well-known Anthropic models ──────────────────────────────

/**
 * Fetch the live list of available models from Anthropic's /v1/models endpoint.
 * Requires valid OAuth credentials with anthropic-beta headers.
 */
export async function fetchAnthropicModels(accessToken: string): Promise<string[]> {
	const headers: Record<string, string> = {
		...getAnthropicHeaders(accessToken),
		accept: "application/json",
	};

	try {
		const response = await fetch("https://api.anthropic.com/v1/models", { headers });
		if (!response.ok) {
			console.warn(`dispatch: Anthropic /v1/models returned ${response.status}`);
			return [];
		}

		const data = (await response.json()) as {
			data?: Array<{ id: string }>;
			models?: Array<{ id: string }>;
		};
		const entries = data.data ?? data.models ?? [];
		return entries.map((m) => m.id).filter(Boolean);
	} catch (err) {
		console.warn(
			`dispatch: failed to fetch Anthropic models: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}

/** Fallback list if /v1/models is unreachable. */
export const ANTHROPIC_MODELS_FALLBACK = [
	"claude-sonnet-4-20250514",
	"claude-opus-4-20250514",
	"claude-3.5-sonnet-20241022",
	"claude-3.5-haiku-20241022",
	"claude-3-opus-20240229",
];

/**
 * Pick the model to use for a Claude "wake" probe from a list of model ids.
 *
 * The probe only needs a small/cheap model to register activity against the
 * subscription, so we target Haiku. Model ids change over time (the old
 * hardcoded `claude-3-5-haiku-20241022` started returning HTTP 404), so the
 * caller fetches the live list from `/v1/models` and we resolve by substring.
 *
 * Selection: the FIRST id whose name contains "haiku" (case-insensitive).
 * Anthropic's `/v1/models` returns models newest-first, so first-match
 * naturally prefers the newest Haiku. Returns `null` when nothing matches so
 * the caller can surface a clear error instead of probing an invalid model.
 */
export function selectHaikuModel(models: string[]): string | null {
	return models.find((id) => id.toLowerCase().includes("haiku")) ?? null;
}

// ─── Credential Validation ────────────────────────────────────

export interface ClaudeProfile {
	accountId?: string;
	email?: string;
	subscriptionType?: string;
}

/**
 * Validate that Claude credentials are usable by hitting the OAuth profile endpoint.
 * Returns the profile info if valid, or null if the token is dead.
 */
export async function validateAccountCredentials(
	account: ClaudeAccount,
): Promise<ClaudeProfile | null> {
	const creds = await refreshAccountCredentialsAsync(account);
	if (!creds) return null;

	const url = "https://api.anthropic.com/api/oauth/profile";
	const headers: Record<string, string> = {
		...getAnthropicHeaders(creds.accessToken),
		accept: "application/json, text/plain, */*",
	};

	try {
		const response = await fetch(url, { headers });
		if (!response.ok) return null;

		const data = (await response.json()) as Record<string, unknown>;

		const profile: ClaudeProfile = {};
		const uuid = typeof data.uuid === "string" ? data.uuid : undefined;
		const email = typeof data.email === "string" ? data.email : undefined;

		if (uuid) profile.accountId = uuid;
		if (email) profile.email = email;

		// subscriptionType comes from the credentials file, but profile may also carry it
		profile.subscriptionType = account.credentials.subscriptionType;

		return profile;
	} catch {
		return null;
	}
}

async function fetchClaudeUsage(accessToken: string): Promise<ClaudeUsageReport | null> {
	const url = "https://api.anthropic.com/api/oauth/usage";
	const headers: Record<string, string> = {
		...getAnthropicHeaders(accessToken),
		accept: "application/json, text/plain, */*",
		"content-type": "application/json",
	};

	try {
		const response = await fetch(url, { headers });
		if (!response.ok) return null;

		const orgId = response.headers.get("anthropic-organization-id")?.trim() || undefined;
		const data = (await response.json()) as Record<string, unknown>;

		const parseBucket = (bucket: unknown): ClaudeUsageBucket | undefined => {
			if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return undefined;
			const b = bucket as Record<string, unknown>;
			// API returns utilization as 0-100 percentage; normalize to 0-1 fraction
			const rawUtil = typeof b.utilization === "number" ? b.utilization : undefined;
			const utilization = rawUtil !== undefined ? rawUtil / 100 : undefined;
			const resetsAt =
				typeof b.resets_at === "string" ? Date.parse(b.resets_at as string) : undefined;
			if (utilization === undefined && resetsAt === undefined) return undefined;
			return { utilization, resetsAt };
		};

		const report: ClaudeUsageReport = {
			fiveHour: parseBucket(data.five_hour),
			sevenDay: parseBucket(data.seven_day),
			sevenDayOpus: parseBucket(data.seven_day_opus),
			sevenDaySonnet: parseBucket(data.seven_day_sonnet),
		};

		if (orgId) report.orgId = orgId;

		// Try to extract identity
		const accountId =
			typeof data.account_id === "string"
				? data.account_id
				: typeof data.user_id === "string"
					? data.user_id
					: typeof data.org_id === "string"
						? data.org_id
						: undefined;
		if (accountId) report.accountId = accountId;

		const email = typeof data.email === "string" ? data.email : undefined;
		if (email) report.email = email;

		return report;
	} catch {
		return null;
	}
}

function getCachedUsage(keyId: string): ClaudeUsageReport | null {
	try {
		const db = getDatabase();
		const row = db
			.query("SELECT report_json FROM usage_cache WHERE key_id = $keyId")
			.get({ $keyId: keyId }) as { report_json: string } | null;
		if (!row) return null;
		return JSON.parse(row.report_json) as ClaudeUsageReport;
	} catch {
		return null;
	}
}

function setCachedUsage(keyId: string, provider: string, report: ClaudeUsageReport): void {
	try {
		const db = getDatabase();
		db.query(
			`INSERT INTO usage_cache (key_id, provider, cached_at, report_json)
			 VALUES ($keyId, $provider, $cachedAt, $reportJson)
			 ON CONFLICT(key_id) DO UPDATE SET
			   cached_at = $cachedAt,
			   report_json = $reportJson`,
		).run({
			$keyId: keyId,
			$provider: provider,
			$cachedAt: Date.now(),
			$reportJson: JSON.stringify(report),
		});
	} catch {
		// Ignore DB errors
	}
}

export async function getAccountUsage(account: ClaudeAccount): Promise<ClaudeUsageReport | null> {
	const creds = await refreshAccountCredentialsAsync(account);
	if (!creds) return getCachedUsage(account.id);
	const report = await fetchClaudeUsage(creds.accessToken);
	if (report) {
		setCachedUsage(account.id, "anthropic", report);
		return report;
	}
	return getCachedUsage(account.id);
}
