import { Hono } from "hono";
import type { ModelRegistry, ModelResolver } from "@dispatch/core";
import {
	type ClaudeAccount,
	discoverClaudeAccounts,
	validateAccountCredentials,
	fetchAnthropicModels,
	ANTHROPIC_MODELS_FALLBACK,
	getAccountUsage,
} from "@dispatch/core";

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
		const accounts = discoverClaudeAccounts();
		const account = credFile
			? accounts.find((a) => a.source === credFile)
			: accounts[0];

		if (!account) {
			return c.json({ error: "no Claude credentials found" }, 500);
		}

		const profile = await validateAccountCredentials(account);
		if (!profile) {
			return c.json({ error: "Claude credentials are invalid or expired", details: "Run `claude` to re-authenticate." }, 401);
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

	const apiKeyValue = key.definition.env ? process.env[key.definition.env] : undefined;
	if (!apiKeyValue) {
		return c.json({ error: `env var not set: ${key.definition.env}` }, 500);
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
		return c.json({ error: "provider API returned error", status: response.status, details: text }, 502);
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
	const candidates = discoverClaudeAccounts();

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
	const accountAccounts = discoverClaudeAccounts();
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