import type { ModelRegistry, ModelResolver } from "@dispatch/core";
import {
	ANTHROPIC_MODELS_FALLBACK,
	type ClaudeAccount,
	fetchAnthropicModels,
	getClaudeAccountsFromDB,
	fetchCopilotUsage,
	fetchOpencodeUsage,
	getAccountUsage,
	getAnthropicHeaders,
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

let getRegistry: () => ModelRegistry | null = () => null;
let getResolver: () => ModelResolver | null = () => null;
let getAccounts: () => ClaudeAccount[] = () => [];

export function setModelsGetter(
	registryGetter: () => ModelRegistry | null,
	resolverGetter: () => ModelResolver | null,
): void {
	getRegistry = registryGetter;
	getResolver = resolverGetter;
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
		return c.json({ models: [], tags: [], keys: [] });
	}

	const models = registry.getModels();
	const tags = registry.getAllTags();
	const keyStates = registry.getKeys();

	const keys = keyStates.map((ks) => ({
		id: ks.definition.id,
		provider: ks.definition.provider,
		status: ks.status,
		lastError: ks.lastError ?? null,
		exhaustedAt: ks.exhaustedAt ?? null,
	}));

	return c.json({ models, tags, keys });
});

modelsRoutes.get("/resolve", (c) => {
	const registry = getRegistry();
	const resolver = getResolver();
	if (!registry || !resolver) {
		return c.json({ resolved: null, reason: "no models configured" });
	}

	const tag = c.req.query("tag");
	if (!tag) {
		return c.json({ error: "tag query parameter is required" }, 400);
	}

	const matchingModels = registry.getModelsByTag(tag);
	if (matchingModels.length === 0) {
		return c.json({ resolved: null, reason: "no models match tag" });
	}

	const resolved = resolver.resolve(tag);
	if (!resolved) {
		return c.json({ resolved: null, reason: "all keys exhausted for matching providers" });
	}

	return c.json({
		resolved: {
			model: resolved.model,
			key: {
				id: resolved.key.id,
				provider: resolved.key.provider,
			},
		},
	});
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
		const account = accounts.find((a) => a.id === keyId)
			?? (credFile ? accounts.find((a) => a.source === credFile) : accounts[0]);

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

	const apiKeyValue = resolveApiKey(keyId!);
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

	const models = data.data.map((m) => m.id);
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
			const token = resolveApiKey(keyId);
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
	const accounts = configuredKeyIds.size > 0
		? allAccounts.filter((a) => configuredKeyIds.has(a.id))
		: allAccounts;
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

type WakeSchedule = Record<number, number>; // hour → next wake timestamp (ms)

interface PendingRetry {
	retriesLeft: number; // starts at 6 (5 min × 6 = 30 min)
	nextRetryAt: number; // timestamp for next retry attempt
}

function nextOccurrenceAt15(hour: number): number {
	const now = new Date();
	const target = new Date(now);
	target.setHours(hour, 15, 0, 0);
	if (target.getTime() <= Date.now()) {
		target.setDate(target.getDate() + 1);
	}
	return target.getTime();
}

function loadScheduleFromDB(): WakeSchedule {
	try {
		const db = getDatabase();
		const rows = db.query("SELECT hour, next_wake_at FROM wake_schedule").all() as Array<{ hour: number; next_wake_at: number }>;
		const schedule: WakeSchedule = {};
		let needsUpdate = false;
		for (const row of rows) {
			if (row.next_wake_at > Date.now()) {
				schedule[row.hour] = row.next_wake_at;
			} else {
				schedule[row.hour] = nextOccurrenceAt15(row.hour);
				needsUpdate = true;
			}
		}
		if (needsUpdate) {
			persistSchedule(schedule);
		}
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
		const insert = db.query("INSERT INTO wake_schedule (hour, next_wake_at) VALUES ($hour, $nextWakeAt)");
		for (const [hour, nextWakeAt] of Object.entries(data)) {
			insert.run({ $hour: Number(hour), $nextWakeAt: nextWakeAt });
		}
	} catch {
		// Ignore DB errors
	}
}

let wakeSchedule: WakeSchedule = loadScheduleFromDB();
let pendingRetries: PendingRetry[] = [];

// HMR-safe: clear previous tick before starting a new one
(globalThis as Record<string, unknown>)._dispatchWakeTimer ??= undefined;
const timerKey = "_dispatchWakeTimer";
let isTickRunning = false;

async function schedulerTick(): Promise<void> {
	// Prevent concurrent tick execution (e.g. toggle called mid-tick)
	if (isTickRunning) return;
	isTickRunning = true;

	try {
		const now = Date.now();
		const hours = Object.keys(wakeSchedule).map(Number);

		for (const hour of hours) {
			const ts = wakeSchedule[hour];
			if (ts !== undefined && ts <= now) {
				// Reschedule for next day (recurring daily)
				wakeSchedule[hour] = nextOccurrenceAt15(hour);
				persistSchedule();

				// Wake accounts and track failures for retry
				try {
					const results = await wakeAllClaudeAccounts();
					const anyFailed = results.some((r) => !r.ok);
					if (anyFailed) {
						pendingRetries.push({
							retriesLeft: 6,
							nextRetryAt: now + 5 * 60 * 1000,
						});
					}
				} catch {
					// Total failure — schedule retry
					pendingRetries.push({
						retriesLeft: 6,
						nextRetryAt: now + 5 * 60 * 1000,
					});
				}
			}
		}

		// Process pending retries (iterate backwards for safe splicing)
		for (let i = pendingRetries.length - 1; i >= 0; i--) {
			const retry = pendingRetries[i];
			if (!retry || retry.nextRetryAt > now) continue;

			try {
				const results = await wakeAllClaudeAccounts();
				const anyFailed = results.some((r) => !r.ok);
				if (!anyFailed || retry.retriesLeft <= 1) {
					// All succeeded or out of retries — remove
					pendingRetries.splice(i, 1);
				} else {
					retry.retriesLeft--;
					retry.nextRetryAt = now + 5 * 60 * 1000;
				}
			} catch {
				if (retry.retriesLeft <= 1) {
					pendingRetries.splice(i, 1);
				} else {
					retry.retriesLeft--;
					retry.nextRetryAt = now + 5 * 60 * 1000;
				}
			}
		}

		// Schedule next tick while there's work to monitor
		if (Object.keys(wakeSchedule).length > 0 || pendingRetries.length > 0) {
			(globalThis as Record<string, unknown>)[timerKey] = setTimeout(schedulerTick, 30_000);
		}
	} finally {
		isTickRunning = false;
	}
}

export function startWakeScheduler(): void {
	// Clear any previous timer (HMR-safe — works with Bun's Timer objects)
	const prev = (globalThis as Record<string, unknown>)[timerKey];
	if (prev != null) clearTimeout(prev as ReturnType<typeof setTimeout>);
	schedulerTick();
}

modelsRoutes.post("/wake-schedule/toggle", async (c) => {
	const body = await c.req.json<{ hour?: number; timestamp?: number }>();
	const hour = body.hour;
	if (typeof hour !== "number" || !Number.isFinite(hour) || hour < 0 || hour > 23) {
		return c.json({ error: "hour must be a number 0-23" }, 400);
	}

	if (wakeSchedule[hour] !== undefined) {
		// Delete
		delete wakeSchedule[hour];
	} else {
		// Add — require a future timestamp
		const ts = body.timestamp;
		if (typeof ts !== "number" || ts <= Date.now()) {
			return c.json({ error: "timestamp must be a future Unix ms value" }, 400);
		}
		wakeSchedule[hour] = ts;
	}

	// Persist and restart the tick loop
	persistSchedule();
	startWakeScheduler();

	return c.json({ schedule: wakeSchedule });
});

modelsRoutes.get("/wake-schedule", (c) => {
	return c.json({ schedule: wakeSchedule });
});
