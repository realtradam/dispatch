import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

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

	if ((creds as Record<string, unknown>).mcpOAuth && !(creds as Record<string, unknown>).accessToken) {
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
		subscriptionType: typeof creds.subscriptionType === "string" ? creds.subscriptionType : undefined,
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

		const data = await response.json() as Record<string, unknown>;
		if (!data.access_token || typeof data.access_token !== "string") {
			return null;
		}

		return {
			accessToken: data.access_token as string,
			refreshToken: (data.refresh_token as string) ?? refreshToken,
			expiresAt: Date.now() + ((data.expires_in as number) ?? 36_000) * 1000,
			subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : undefined,
		};
	} catch {
		return null;
	}
}

function buildAccountLabels(accounts: ClaudeAccount[]): void {
	const counts = new Map<string, number>();
	for (const acct of accounts) {
		const base = acct.credentials.subscriptionType
			? `Claude ${acct.credentials.subscriptionType.charAt(0).toUpperCase() + acct.credentials.subscriptionType.slice(1)}`
			: "Claude";
		const count = (counts.get(base) ?? 0) + 1;
		counts.set(base, count);
		acct.label = count > 1 ? `${base} ${count}` : base;
	}
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
	if (cached && now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS && cached.creds.expiresAt > now + 60_000) {
		return cached.creds;
	}

	// Re-read from file to pick up external updates
	const onDisk = readCredentialsFile(account.source);
	if (onDisk) {
		account.credentials = onDisk;
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

export async function refreshAccountCredentialsAsync(account: ClaudeAccount): Promise<ClaudeCredentials | null> {
	const cached = accountCacheMap.get(account.id);
	const now = Date.now();
	if (cached && now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS && cached.creds.expiresAt > now + 60_000) {
		return cached.creds;
	}

	// Re-read from file
	const onDisk = readCredentialsFile(account.source);
	if (onDisk) {
		account.credentials = onDisk;
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
			writeCredentialsFile(account.source, refreshed);
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
	const sampled = [4, 7, 20]
		.map((i) => (i < messageText.length ? messageText[i] : "0"))
		.join("");
	const input = `${BILLING_SALT}${sampled}${version}`;
	return createHash("sha256").update(input).digest("hex").slice(0, 3);
}

export function buildBillingHeaderValue(messages: Array<{ role: string; content: string }>): string {
	const text = extractFirstUserMessageText(messages);
	const version = process.env.ANTHROPIC_CLI_VERSION ?? CC_VERSION;
	const suffix = computeVersionSuffix(text, version);
	const cch = computeCch(text);
	return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`;
}

export const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

// ─── Anthropic Beta Headers ───────────────────────────────────

const BASE_BETAS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
	"context-management-2025-06-27",
	"advisor-tool-2026-03-01",
];

export function getAnthropicBetas(): string[] {
	return [...BASE_BETAS];
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

		const data = (await response.json()) as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
		const entries = data.data ?? data.models ?? [];
		return entries.map((m) => m.id).filter(Boolean);
	} catch (err) {
		console.warn(`dispatch: failed to fetch Anthropic models: ${err instanceof Error ? err.message : String(err)}`);
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
export async function validateAccountCredentials(account: ClaudeAccount): Promise<ClaudeProfile | null> {
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
			const resetsAt = typeof b.resets_at === "string" ? Date.parse(b.resets_at as string) : undefined;
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
			typeof data.account_id === "string" ? data.account_id :
			typeof data.user_id === "string" ? data.user_id :
			typeof data.org_id === "string" ? data.org_id : undefined;
		if (accountId) report.accountId = accountId;

		const email = typeof data.email === "string" ? data.email : undefined;
		if (email) report.email = email;

		return report;
	} catch {
		return null;
	}
}

const usageCacheMap = new Map<string, ClaudeUsageReport>();

export async function getAccountUsage(account: ClaudeAccount): Promise<ClaudeUsageReport | null> {
	const creds = await refreshAccountCredentialsAsync(account);
	if (!creds) return usageCacheMap.get(account.id) ?? null;
	const report = await fetchClaudeUsage(creds.accessToken);
	if (report) {
		usageCacheMap.set(account.id, report);
		return report;
	}
	return usageCacheMap.get(account.id) ?? null;
}