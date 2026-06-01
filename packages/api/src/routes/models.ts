import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { ModelRegistry } from "@dispatch/core";
import {
	ANTHROPIC_MODELS_FALLBACK,
	type ClaudeAccount,
	fetchAnthropicModels,
	fetchCopilotUsage,
	fetchGoogleUsage,
	fetchOpencodeUsage,
	getAccountUsage,
	getAnthropicHeaders,
	getClaudeAccountsFromDB,
	getDatabase,
	importCredentialsFromFile,
	listApiKeys,
	listStoredCredentials,
	refreshAccountCredentialsAsync,
	resolveApiKey,
	setApiKey,
	validateAccountCredentials,
} from "@dispatch/core";
import { Hono } from "hono";
import {
	CLAUDE_RESET_OFFSET_HOURS,
	isProbeSlotMinute,
	nextDailyAfter,
	PROBE_SLOT_MINUTES,
	type ProbeSlotMinute,
	recoverScheduleEntry,
} from "../wake-scheduler.js";

let getRegistry: () => ModelRegistry | null = () => null;
let getAccounts: () => ClaudeAccount[] = () => [];

export function setModelsGetter(registryGetter: () => ModelRegistry | null): void {
	getRegistry = registryGetter;
}

export function setAccountsGetter(getter: () => ClaudeAccount[]): void {
	getAccounts = getter;
}

/** Load Claude accounts from the database. */
function resolveClaudeAccounts(): ClaudeAccount[] {
	return getClaudeAccountsFromDB();
}

export const modelsRoutes = new Hono();

modelsRoutes.get("/", (c) => {
	const registry = getRegistry();
	if (!registry) {
		return c.json({ keys: [] });
	}

	const keyStates = registry.getKeys();

	const keys = keyStates.map((ks) => ({
		id: ks.definition.id,
		provider: ks.definition.provider,
		status: ks.status,
		lastError: ks.lastError ?? null,
		exhaustedAt: ks.exhaustedAt ?? null,
	}));

	return c.json({ keys });
});

// Fetch available models for a specific provider key.
modelsRoutes.get("/available", async (c) => {
	const registry = getRegistry();
	if (!registry) {
		return c.json({ error: "no registry configured" }, 500);
	}

	const keyId = c.req.query("keyId");
	if (!keyId) {
		return c.json({ error: "keyId query parameter is required" }, 400);
	}

	const keyStates = registry.getKeys();
	const key = keyStates.find((ks) => ks.definition.id === keyId);
	if (!key) {
		return c.json({ error: `key not found: ${keyId}` }, 404);
	}

	// Anthropic provider: validate credentials and fetch models dynamically
	if (key.definition.provider === "anthropic") {
		const credFile = key.definition.credentials_file;
		const accounts = resolveClaudeAccounts();
		const account =
			accounts.find((a) => a.id === keyId) ??
			(credFile ? accounts.find((a) => a.source === credFile) : accounts[0]);

		if (!account) {
			return c.json({ error: "no Claude credentials found" }, 500);
		}

		const profile = await validateAccountCredentials(account);
		if (!profile) {
			return c.json(
				{
					error: "Claude credentials are invalid or expired",
					details: "Run `claude` to re-authenticate.",
				},
				401,
			);
		}

		const creds = account.credentials;
		let models = await fetchAnthropicModels(creds.accessToken);
		if (models.length === 0) {
			models = ANTHROPIC_MODELS_FALLBACK;
		}

		return c.json({
			models,
			subscriptionType: account.credentials.subscriptionType,
			...(profile.email ? { email: profile.email } : {}),
		});
	}

	const apiKeyValue = resolveApiKey(keyId, key.definition.env);
	if (!apiKeyValue) {
		return c.json({ error: `no API key found for ${keyId}` }, 500);
	}

	const baseUrl = key.definition.base_url.replace(/\/+$/, "");
	const url = `${baseUrl}/models`;
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKeyValue}`,
	};
	if (key.definition.provider === "github-copilot") {
		headers["Copilot-Integration-Id"] = "vscode-chat";
	}

	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch (err) {
		return c.json({ error: "provider API call failed", details: String(err) }, 502);
	}

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return c.json(
			{ error: "provider API returned error", status: response.status, details: text },
			502,
		);
	}

	let data: { data: { id: string }[] };
	try {
		data = await response.json();
	} catch (err) {
		return c.json({ error: "failed to parse provider response", details: String(err) }, 502);
	}

	const models = data.data.map((m) => m.id.replace(/^models\//, ""));
	return c.json({ models });
});

// List available Claude accounts with validated credentials
modelsRoutes.get("/claude-accounts", async (c) => {
	const candidates = resolveClaudeAccounts();

	// Validate each account's credentials; only include ones with a working token
	const validated: Array<{
		id: string;
		label: string;
		source: string;
		subscriptionType: string;
		expiresAt: number;
		email?: string;
	}> = [];

	for (const acct of candidates) {
		const profile = await validateAccountCredentials(acct);
		if (profile) {
			validated.push({
				id: acct.id,
				label: acct.label,
				source: acct.source,
				subscriptionType: acct.credentials.subscriptionType ?? "unknown",
				expiresAt: acct.credentials.expiresAt,
				...(profile.email ? { email: profile.email } : {}),
			});
		}
	}

	return c.json({ accounts: validated });
});

// Get usage for a specific Claude account
modelsRoutes.get("/claude-usage", async (c) => {
	const accountId = c.req.query("accountId");
	const accounts = getAccounts();
	const accountAccounts = resolveClaudeAccounts();
	const allAccounts = accounts.length > 0 ? accounts : accountAccounts;

	let account: ClaudeAccount | undefined;
	if (accountId) {
		account = allAccounts.find((a) => a.id === accountId);
		if (!account) {
			return c.json({ error: `account not found: ${accountId}` }, 404);
		}
	} else {
		account = allAccounts[0];
	}

	if (!account) {
		return c.json({ error: "no Claude accounts available" }, 404);
	}

	const report = await getAccountUsage(account);
	if (!report) {
		return c.json({ error: "failed to fetch usage data" }, 502);
	}

	return c.json(report);
});

// Get usage for a specific key by ID
modelsRoutes.get("/key-usage", async (c) => {
	const keyId = c.req.query("keyId");
	if (!keyId) {
		return c.json({ error: "keyId query parameter is required" }, 400);
	}

	const registry = getRegistry();
	if (!registry) {
		return c.json({ error: "registry not available" }, 502);
	}

	const keys = registry.getKeys();
	const key = keys.find((k) => k.definition.id === keyId);
	if (!key) {
		return c.json({ error: `key not found: ${keyId}` }, 404);
	}

	const provider = key.definition.provider;

	try {
		if (provider === "anthropic") {
			const allAccounts = resolveClaudeAccounts();
			const credFile = key.definition.credentials_file;
			// Match by key ID (DB accounts) or source file (file accounts)
			const accounts = allAccounts.filter(
				(a) => a.id === keyId || (credFile && a.source === credFile),
			);
			if (accounts.length === 0 && allAccounts[0]) {
				accounts.push(allAccounts[0]);
			}
			if (accounts.length === 0) {
				return c.json({ error: "no Claude accounts available" }, 502);
			}
			// Fetch usage for matched accounts
			const accountResults = await Promise.all(
				accounts.map(async (acct) => {
					const report = await getAccountUsage(acct);
					return {
						label: acct.label,
						source: acct.source,
						subscriptionType: acct.credentials.subscriptionType,
						fiveHour: report?.fiveHour,
						sevenDay: report?.sevenDay,
						error: report ? undefined : "failed to fetch",
					};
				}),
			);
			return c.json({
				provider: "anthropic",
				accounts: accountResults,
				// Legacy single-account fields (first account)
				fiveHour: accountResults[0]?.fiveHour,
				sevenDay: accountResults[0]?.sevenDay,
			});
		} else if (provider === "opencode-go") {
			// Cookie-based HTML scraper. Uses OPENCODE_COOKIE env var plus
			// OPENCODE_WS1_ID / OPENCODE_WS2_ID (keyed by the key's numeric suffix).
			const report = await fetchOpencodeUsage(key.definition.id);
			if (report) {
				return c.json({
					provider: "opencode-go",
					fiveHour: report.fiveHour,
					weekly: report.weekly,
					monthly: report.monthly,
				});
			}
			// Fall back: show limits info with link to console
			return c.json({
				provider: "opencode-go",
				unavailable: true,
				consoleUrl: "https://opencode.ai/auth",
				limits: {
					fiveHour: "$12",
					weekly: "$30",
					monthly: "$60",
				},
			});
		} else if (provider === "github-copilot") {
			const token = resolveApiKey(keyId, key.definition.env);
			if (!token) {
				return c.json({ error: `no API key found for ${keyId}` }, 502);
			}
			const report = await fetchCopilotUsage(token, key.definition.base_url);
			if (!report) {
				return c.json({ error: "failed to fetch usage data" }, 502);
			}
			return c.json({
				provider: "github-copilot",
				tokensConsumed: report.tokensConsumed,
				tokensRemaining: report.tokensRemaining,
				percentUsed: report.percentUsed,
				resetAt: report.resetAt,
				plan: report.plan,
			});
		} else if (provider === "google") {
			const token = resolveApiKey(keyId, key.definition.env);
			if (!token) {
				return c.json({ error: `no API key found for ${keyId}. Set GOOGLE_API_KEY env var.` }, 502);
			}
			const report = await fetchGoogleUsage(token, key.definition.base_url);
			if (!report) {
				return c.json({ error: "failed to fetch Google usage data" }, 502);
			}
			return c.json({
				provider: "google",
				models: report.models,
				currentUsage: report.currentUsage,
				weeklyUsage: report.weeklyUsage,
			});
		} else {
			return c.json({ error: "usage tracking not supported for this provider" }, 400);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: `failed to fetch usage: ${message}` }, 502);
	}
});

// ─── API key management ───────────────────────────────────────

modelsRoutes.post("/set-api-key", async (c) => {
	const body = await c.req.json<{ keyId?: string; apiKey?: string }>();
	if (typeof body.keyId !== "string" || !body.keyId) {
		return c.json({ error: "keyId is required" }, 400);
	}
	if (typeof body.apiKey !== "string" || !body.apiKey) {
		return c.json({ error: "apiKey is required" }, 400);
	}

	const registry = getRegistry();
	if (!registry) {
		return c.json({ error: "registry not available" }, 502);
	}

	const keys = registry.getKeys();
	const key = keys.find((k) => k.definition.id === body.keyId);
	if (!key) {
		return c.json({ error: `key not found: ${body.keyId}` }, 404);
	}

	setApiKey(body.keyId, key.definition.provider, body.apiKey);
	return c.json({ success: true, keyId: body.keyId });
});

modelsRoutes.get("/api-keys-status", (c) => {
	const stored = listApiKeys();
	return c.json({ keys: stored });
});

// ─── Credential import ────────────────────────────────────────

modelsRoutes.post("/import-credentials", async (c) => {
	const body = await c.req.json<{ keyId?: string }>();
	const keyId = body.keyId;
	if (typeof keyId !== "string" || !keyId) {
		return c.json({ error: "keyId is required" }, 400);
	}

	const registry = getRegistry();
	if (!registry) {
		return c.json({ error: "registry not available" }, 502);
	}

	const keys = registry.getKeys();
	const key = keys.find((k) => k.definition.id === keyId);
	if (!key) {
		return c.json({ error: `key not found: ${keyId}` }, 404);
	}

	if (key.definition.provider !== "anthropic") {
		return c.json({ error: "credential import is only supported for anthropic keys" }, 400);
	}

	const credFile = key.definition.credentials_file;
	if (!credFile) {
		return c.json({ error: "no credentials_file configured for this key" }, 400);
	}

	const result = importCredentialsFromFile(keyId, key.definition.provider, credFile);
	if (!result.success) {
		return c.json({ error: result.error ?? "import failed" }, 400);
	}

	return c.json({ success: true, keyId });
});

modelsRoutes.get("/credentials-status", (c) => {
	const stored = listStoredCredentials();
	const status = stored.map((cred) => ({
		keyId: cred.keyId,
		provider: cred.provider,
		subscriptionType: cred.subscriptionType,
		sourceFile: cred.sourceFile,
		importedAt: cred.importedAt,
		updatedAt: cred.updatedAt,
		expired: cred.expiresAt < Date.now(),
	}));
	return c.json({ credentials: status });
});

// ─── Add key to dispatch.toml ─────────────────────────────────

const VALID_PROVIDERS = ["anthropic", "opencode-go", "google"] as const;
type SupportedProvider = (typeof VALID_PROVIDERS)[number];

const PROVIDER_BASE_URLS: Record<SupportedProvider, string> = {
	anthropic: "https://api.anthropic.com/v1",
	"opencode-go": "https://opencode.ai/zen/go/v1",
	google: "https://generativelanguage.googleapis.com/v1beta/openai",
};

modelsRoutes.post("/add-key", async (c) => {
	const body = await c.req.json<{ id?: unknown; provider?: unknown }>();

	// Validate id
	if (typeof body.id !== "string" || !body.id.trim() || !/^[a-zA-Z0-9_-]+$/.test(body.id.trim())) {
		return c.json({ error: "id must contain only letters, numbers, dashes, and underscores" }, 400);
	}
	const id = body.id.trim();

	// Validate provider
	if (!VALID_PROVIDERS.includes(body.provider as SupportedProvider)) {
		return c.json({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` }, 400);
	}
	const provider = body.provider as SupportedProvider;
	const base_url = PROVIDER_BASE_URLS[provider];

	// Read current dispatch.toml
	const tomlPath = `${process.cwd()}/dispatch.toml`;
	let tomlContent: string;
	try {
		tomlContent = readFileSync(tomlPath, "utf-8");
	} catch (err) {
		return c.json({ error: `failed to read dispatch.toml: ${String(err)}` }, 500);
	}

	// Check for duplicate key id
	const idPattern = new RegExp(`^\\s*id\\s*=\\s*["']?${id}["']?\\s*$`, "m");
	if (idPattern.test(tomlContent)) {
		return c.json({ error: `key with id "${id}" already exists` }, 409);
	}

	// Build the new [[keys]] block
	let newBlock = `\n[[keys]]\nid = "${id}"\nprovider = "${provider}"\nbase_url = "${base_url}"`;
	if (provider === "anthropic") {
		const credPath = `${homedir()}/.claude/.credentials-${id}.json`;
		newBlock += `\ncredentials_file = "${credPath}"`;
	} else {
		const envVar =
			provider === "google"
				? "GOOGLE_API_KEY"
				: `DISPATCH_${id.toUpperCase().replace(/-/g, "_")}_KEY`;
		newBlock += `\nenv = "${envVar}"`;
	}
	newBlock += "\n";

	// Insert before the # ─── Permissions section if it exists, otherwise at end
	const permissionsMarker = /\n# [─-]+ Permissions/;
	let newContent: string;
	const permMatch = permissionsMarker.exec(tomlContent);
	if (permMatch) {
		const insertAt = permMatch.index;
		newContent = tomlContent.slice(0, insertAt) + newBlock + tomlContent.slice(insertAt);
	} else {
		newContent = tomlContent + newBlock;
	}

	try {
		writeFileSync(tomlPath, newContent, "utf-8");
	} catch (err) {
		return c.json({ error: `failed to write dispatch.toml: ${String(err)}` }, 500);
	}

	const key: { id: string; provider: string; base_url: string; credentials_file?: string } = {
		id,
		provider,
		base_url,
	};
	if (provider === "anthropic") {
		key.credentials_file = `${homedir()}/.claude/.credentials-${id}.json`;
	}

	return c.json({ success: true, key });
});

// ─── Remove key from dispatch.toml ────────────────────────────

modelsRoutes.post("/remove-key", async (c) => {
	const body = await c.req.json<{ id?: unknown }>();

	if (typeof body.id !== "string" || !body.id.trim()) {
		return c.json({ error: "id is required" }, 400);
	}
	const id = body.id.trim();

	const tomlPath = `${process.cwd()}/dispatch.toml`;
	let tomlContent: string;
	try {
		tomlContent = readFileSync(tomlPath, "utf-8");
	} catch (err) {
		return c.json({ error: `failed to read dispatch.toml: ${String(err)}` }, 500);
	}

	// Match the [[keys]] block containing this id and remove it.
	// A block starts with [[keys]] and ends at the next [[...]] header, # ─── section marker, or EOF.
	const blockPattern = new RegExp(
		`\\n?\\[\\[keys\\]\\]\\n(?:[^\\[#]|#(?! [─\\-]))*?id\\s*=\\s*"${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^\\[#]*(?:\\n(?=\\[|# [─\\-])|$)`,
		"s",
	);
	const match = blockPattern.exec(tomlContent);
	if (!match) {
		return c.json({ error: `key "${id}" not found in dispatch.toml` }, 404);
	}

	const newContent =
		tomlContent.slice(0, match.index) + tomlContent.slice(match.index + match[0].length);

	try {
		writeFileSync(tomlPath, newContent, "utf-8");
	} catch (err) {
		return c.json({ error: `failed to write dispatch.toml: ${String(err)}` }, 500);
	}

	return c.json({ success: true });
});

// ─── Shared wake function ─────────────────────────────────────

async function wakeAllClaudeAccounts(): Promise<
	Array<{ label: string; ok: boolean; error?: string }>
> {
	// Only wake accounts referenced by configured anthropic keys
	const allAccounts = resolveClaudeAccounts();
	const registry = getRegistry();
	const configuredKeyIds = new Set<string>();
	if (registry) {
		for (const ks of registry.getKeys()) {
			if (ks.definition.provider === "anthropic") {
				configuredKeyIds.add(ks.definition.id);
			}
		}
	}
	const accounts =
		configuredKeyIds.size > 0 ? allAccounts.filter((a) => configuredKeyIds.has(a.id)) : allAccounts;
	if (accounts.length === 0) {
		return [{ label: "(none)", ok: false, error: "no Claude accounts available" }];
	}

	const results: Array<{ label: string; ok: boolean; error?: string }> = [];

	for (const acct of accounts) {
		try {
			const creds = await refreshAccountCredentialsAsync(acct);
			if (!creds) {
				results.push({ label: acct.label, ok: false, error: "token refresh failed" });
				continue;
			}

			const res = await fetch("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: {
					...getAnthropicHeaders(creds.accessToken),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "claude-3-5-haiku-20241022",
					max_tokens: 16,
					messages: [{ role: "user", content: "hi" }],
				}),
			});

			results.push({ label: acct.label, ok: res.ok });
		} catch (err) {
			results.push({
				label: acct.label,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return results;
}

modelsRoutes.post("/wake", async (c) => {
	const results = await wakeAllClaudeAccounts();
	return c.json({ results });
});

// ─── Wake scheduler (runs on backend, survives frontend close) ─
//
// A "marked hour" expands to 4 probe slots inside that hour: :00, :15, :30,
// :45. Each slot is its own (hour, slot_minute) row in `wake_schedule` with
// its own `next_wake_at`. When multiple slots come due in the same tick we
// coalesce into a single upstream wake — no point hitting Anthropic 4× in
// the same 30-second window.

/** Schedule: hour (0-23) → slot minute (0/15/30/45) → next fire ms. */
type WakeSchedule = Record<number, Partial<Record<ProbeSlotMinute, number>>>;

interface PendingRetry {
	/** Remaining attempts. Starts at MAX_RETRIES (e.g. 6 → 30 min of retries). */
	retriesLeft: number;
	/** Absolute timestamp (ms) of the next retry attempt. */
	nextRetryAt: number;
	/** Why we entered retry mode — surfaced on /wake-schedule. */
	reason: string;
}

interface LastWake {
	firedAt: number;
	ok: boolean;
	results: Array<{ label: string; ok: boolean; error?: string }>;
}

const MAX_RETRIES = 6;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 30_000;

function setSlot(schedule: WakeSchedule, hour: number, minute: ProbeSlotMinute, ts: number): void {
	const hourEntry = schedule[hour] ?? {};
	hourEntry[minute] = ts;
	schedule[hour] = hourEntry;
}

function deleteHour(schedule: WakeSchedule, hour: number): void {
	delete schedule[hour];
}

function countSlots(schedule: WakeSchedule): number {
	let n = 0;
	for (const slots of Object.values(schedule)) {
		n += Object.keys(slots).length;
	}
	return n;
}

function loadScheduleFromDB(): WakeSchedule {
	try {
		const db = getDatabase();
		const rows = db
			.query("SELECT hour, slot_minute, next_wake_at FROM wake_schedule")
			.all() as Array<{ hour: number; slot_minute: number; next_wake_at: number }>;
		const schedule: WakeSchedule = {};
		const now = Date.now();
		let needsPersist = false;
		let anyShouldFire = false;
		for (const row of rows) {
			if (!isProbeSlotMinute(row.slot_minute)) continue; // defensive — schema CHECKs it
			const recovered = recoverScheduleEntry(row.next_wake_at, now);
			setSlot(schedule, row.hour, row.slot_minute, recovered.nextWakeAt);
			if (recovered.nextWakeAt !== row.next_wake_at) needsPersist = true;
			if (recovered.shouldFireNow) anyShouldFire = true;
		}
		if (needsPersist) persistSchedule(schedule);
		if (anyShouldFire) needsBootFire = true;
		return schedule;
	} catch {
		return {};
	}
}

function persistSchedule(scheduleToSave?: WakeSchedule): void {
	try {
		const db = getDatabase();
		const data = scheduleToSave ?? wakeSchedule;
		db.run("DELETE FROM wake_schedule");
		const insert = db.query(
			"INSERT INTO wake_schedule (hour, slot_minute, next_wake_at) VALUES ($hour, $slot, $nextWakeAt)",
		);
		for (const [hour, slots] of Object.entries(data)) {
			for (const [slotMinute, nextWakeAt] of Object.entries(slots)) {
				if (nextWakeAt === undefined) continue;
				insert.run({
					$hour: Number(hour),
					$slot: Number(slotMinute),
					$nextWakeAt: nextWakeAt,
				});
			}
		}
	} catch {
		// Ignore DB errors — schedule still lives in-memory for this process.
	}
}

/** Set to true by loadScheduleFromDB when one or more slots need a boot fire. */
let needsBootFire = false;
const wakeSchedule: WakeSchedule = loadScheduleFromDB();

/**
 * A single shared retry slot. We deliberately do NOT queue one retry per
 * failed wake — multiple back-to-back failures (e.g. the network is down for
 * five minutes) used to spawn retries that all converged on the same instant
 * and hammered the upstream. One in-flight retry covers all accounts.
 */
let pendingRetry: PendingRetry | null = null;
let lastWake: LastWake | null = null;

// HMR-safe: track the scheduler timer on globalThis so re-imports during dev
// don't leave orphaned timers running.
const timerKey = "_dispatchWakeTimer";
(globalThis as Record<string, unknown>)[timerKey] ??= undefined;
let isTickRunning = false;

function recordWake(results: Array<{ label: string; ok: boolean; error?: string }>): boolean {
	const ok = results.length > 0 && results.every((r) => r.ok);
	lastWake = { firedAt: Date.now(), ok, results };
	return ok;
}

function scheduleRetry(reason: string): void {
	if (pendingRetry) {
		// Already retrying — reset the budget so the next failure window covers
		// the new incident too, but don't compound timers.
		pendingRetry.retriesLeft = MAX_RETRIES;
		pendingRetry.nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
		pendingRetry.reason = reason;
		return;
	}
	pendingRetry = {
		retriesLeft: MAX_RETRIES,
		nextRetryAt: Date.now() + RETRY_INTERVAL_MS,
		reason,
	};
}

async function fireWake(reason: string): Promise<void> {
	try {
		const results = await wakeAllClaudeAccounts();
		const ok = recordWake(results);
		if (!ok) scheduleRetry(reason);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		lastWake = {
			firedAt: Date.now(),
			ok: false,
			results: [{ label: "(scheduler)", ok: false, error: message }],
		};
		scheduleRetry(reason);
	}
}

async function processPendingRetry(now: number): Promise<void> {
	// Capture into a local so TS narrowing survives across awaits, and so a
	// racing toggle that clears `pendingRetry` mid-flight can't NPE us.
	const retry = pendingRetry;
	if (!retry || retry.nextRetryAt > now) return;
	try {
		const results = await wakeAllClaudeAccounts();
		const ok = recordWake(results);
		if (ok || retry.retriesLeft <= 1) {
			pendingRetry = null;
		} else {
			retry.retriesLeft -= 1;
			retry.nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		lastWake = {
			firedAt: Date.now(),
			ok: false,
			results: [{ label: "(retry)", ok: false, error: message }],
		};
		if (retry.retriesLeft <= 1) {
			pendingRetry = null;
		} else {
			retry.retriesLeft -= 1;
			retry.nextRetryAt = Date.now() + RETRY_INTERVAL_MS;
		}
	}
}

interface DueSlot {
	hour: number;
	minute: ProbeSlotMinute;
	ts: number;
}

/** Collect every slot whose next_wake_at is at or before `now`. */
function collectDueSlots(now: number): DueSlot[] {
	const due: DueSlot[] = [];
	for (const [hourStr, slots] of Object.entries(wakeSchedule)) {
		const hour = Number(hourStr);
		for (const [slotStr, ts] of Object.entries(slots)) {
			if (ts === undefined) continue;
			const slotMinute = Number(slotStr);
			if (!isProbeSlotMinute(slotMinute)) continue;
			if (ts <= now) due.push({ hour, minute: slotMinute, ts });
		}
	}
	return due;
}

async function schedulerTick(): Promise<void> {
	// Prevent concurrent tick execution (e.g. toggle called mid-tick).
	if (isTickRunning) return;
	isTickRunning = true;

	try {
		const now = Date.now();
		const due = collectDueSlots(now);

		let firedThisTick = false;
		if (due.length > 0 || needsBootFire) {
			needsBootFire = false;
			// Advance every due slot before firing — so a slow upstream call
			// can't cause us to re-fire the same slot on the next tick.
			for (const slot of due) {
				const next = nextDailyAfter(slot.ts, now);
				setSlot(wakeSchedule, slot.hour, slot.minute, next);
			}
			persistSchedule();

			const reasonParts = due.map((d) => `${d.hour}:${String(d.minute).padStart(2, "0")}`);
			const reason =
				reasonParts.length > 0 ? `scheduled probe(s) ${reasonParts.join(", ")}` : "boot recovery";
			firedThisTick = true;
			// COALESCED: one upstream call covers all slots due this tick.
			await fireWake(reason);
		}

		// Only attempt a retry on ticks that didn't *just* fire — otherwise we'd
		// race the retry against a fresh attempt within the same loop iteration.
		if (!firedThisTick) {
			await processPendingRetry(Date.now());
		}

		// Keep ticking while there's anything to monitor.
		if (countSlots(wakeSchedule) > 0 || pendingRetry !== null) {
			(globalThis as Record<string, unknown>)[timerKey] = setTimeout(
				schedulerTick,
				TICK_INTERVAL_MS,
			);
		}
	} finally {
		isTickRunning = false;
	}
}

export function startWakeScheduler(): void {
	// Clear any previous timer (HMR-safe — works with Bun's Timer objects).
	const prev = (globalThis as Record<string, unknown>)[timerKey];
	if (prev != null) clearTimeout(prev as ReturnType<typeof setTimeout>);
	// Fire-and-forget; the tick re-arms itself.
	void schedulerTick();
}

function scheduleSnapshot(): {
	schedule: WakeSchedule;
	resetOffsetHours: number;
	probeSlotMinutes: readonly number[];
	lastWake: LastWake | null;
	pendingRetry: PendingRetry | null;
} {
	return {
		schedule: wakeSchedule,
		resetOffsetHours: CLAUDE_RESET_OFFSET_HOURS,
		probeSlotMinutes: PROBE_SLOT_MINUTES,
		lastWake,
		pendingRetry,
	};
}

modelsRoutes.post("/wake-schedule/toggle", async (c) => {
	const body = await c.req.json<{
		hour?: unknown;
		timestamps?: unknown;
	}>();
	const hour = body.hour;
	if (typeof hour !== "number" || !Number.isFinite(hour) || hour < 0 || hour > 23) {
		return c.json({ error: "hour must be a number 0-23" }, 400);
	}
	if (!Number.isInteger(hour)) {
		return c.json({ error: "hour must be an integer 0-23" }, 400);
	}

	if (wakeSchedule[hour] !== undefined) {
		// Toggle off — remove all 4 slots for this hour.
		deleteHour(wakeSchedule, hour);
	} else {
		// Toggle on — require a `timestamps` object with one absolute Unix ms
		// per probe slot (0, 15, 30, 45). The client is the source of truth
		// for the *local* wall-clock intent of each probe.
		const timestamps = body.timestamps;
		if (timestamps === null || typeof timestamps !== "object") {
			return c.json(
				{ error: "timestamps must be an object { '0': ms, '15': ms, '30': ms, '45': ms }" },
				400,
			);
		}
		const now = Date.now();
		const parsed: Partial<Record<ProbeSlotMinute, number>> = {};
		for (const slot of PROBE_SLOT_MINUTES) {
			const raw = (timestamps as Record<string, unknown>)[String(slot)];
			if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= now) {
				return c.json({ error: `timestamps['${slot}'] must be a future Unix ms value` }, 400);
			}
			parsed[slot] = raw;
		}
		wakeSchedule[hour] = parsed;
	}

	persistSchedule();
	startWakeScheduler();

	return c.json(scheduleSnapshot());
});

modelsRoutes.get("/wake-schedule", (c) => {
	return c.json(scheduleSnapshot());
});
