import { z } from "zod";
import type { ClaudeAccount, ClaudeUsageReport, ClaudeUsageResult } from "../credentials/claude.js";
import { getAccountUsageWithSource } from "../credentials/claude.js";
import type { OpencodeUsageReport } from "../credentials/opencode.js";
import { fetchOpencodeUsage as defaultFetchOpencodeUsage } from "../credentials/opencode.js";
import type { KeyState, ToolDefinition } from "../types/index.js";

/**
 * Collaborators the `key_usage` tool needs from the API layer (which owns the
 * live `ModelRegistry` and the discovered Claude accounts). The two `fetch*`
 * hooks default to the real credential fetchers but are injectable so tests can
 * exercise the tool without network or DB access.
 */
export interface KeyUsageCallbacks {
	/** Current key states from the model registry (definition + active/exhausted status). */
	listKeys(): KeyState[];
	/** Discovered Claude accounts, used to resolve `anthropic` keys to credentials. */
	listClaudeAccounts(): ClaudeAccount[];
	/**
	 * Fetch an anthropic account's usage with provenance (live vs cache).
	 * Defaults to `getAccountUsageWithSource`.
	 */
	fetchAnthropicUsage?: (account: ClaudeAccount) => Promise<ClaudeUsageResult | null>;
	/**
	 * Fetch an opencode-go key's usage (always a live scrape — OpenCode keeps no
	 * local cache). Defaults to `fetchOpencodeUsage`.
	 */
	fetchOpencodeUsage?: (keyId: string) => Promise<OpencodeUsageReport | null>;
}

/** A single normalized usage window (5-hour / week / month). */
interface UsageWindow {
	label: string;
	/** Remaining headroom as a 0–100 percentage. Omitted when the source gives no utilization. */
	remainingPercent?: number;
	/** Epoch-ms the window resets. Omitted when the source gives no reset time. */
	resetsAt?: number;
}

/** Fully normalized per-key usage, ready for rendering. */
interface KeyUsageEntry {
	keyId: string;
	provider: string;
	status: "active" | "exhausted";
	lastError?: string;
	exhaustedAt?: number;
	/** Provenance of the usage figures: a fresh live fetch or a cached payload. */
	dataSource?: "live" | "cache";
	/** Epoch-ms the cached payload was last fetched from source (only on `dataSource: "cache"`). */
	cachedAt?: number;
	windows: UsageWindow[];
	/** Set when no usage figures could be obtained for an otherwise-supported key. */
	unavailableReason?: string;
	/** Set when the provider has no usage-reporting support. */
	unsupported?: boolean;
}

function clampPercent(value: number): number {
	if (value < 0) return 0;
	if (value > 100) return 100;
	return value;
}

/** Convert a raw `{ utilization, resetsAt }` bucket into a normalized window. */
function toWindow(
	label: string,
	bucket?: { utilization?: number; resetsAt?: number },
): UsageWindow | null {
	if (!bucket) return null;
	const hasUtil = typeof bucket.utilization === "number";
	const hasReset = typeof bucket.resetsAt === "number";
	if (!hasUtil && !hasReset) return null;
	return {
		label,
		...(hasUtil
			? { remainingPercent: clampPercent(Math.round((1 - (bucket.utilization as number)) * 100)) }
			: {}),
		...(hasReset ? { resetsAt: bucket.resetsAt } : {}),
	};
}

function anthropicWindows(report: ClaudeUsageReport): UsageWindow[] {
	const windows: UsageWindow[] = [];
	const fiveHour = toWindow("5-hour", report.fiveHour);
	if (fiveHour) windows.push(fiveHour);
	const week = toWindow("week", report.sevenDay);
	if (week) windows.push(week);
	return windows;
}

function opencodeWindows(report: OpencodeUsageReport): UsageWindow[] {
	const windows: UsageWindow[] = [];
	const fiveHour = toWindow("5-hour", report.fiveHour);
	if (fiveHour) windows.push(fiveHour);
	const week = toWindow("week", report.weekly);
	if (week) windows.push(week);
	const month = toWindow("month", report.monthly);
	if (month) windows.push(month);
	return windows;
}

/**
 * Resolve which Claude account backs an `anthropic` key. Matches by key id or by
 * the account's source file (the key's `credentials_file`), falling back to the
 * first available account — mirrors the existing `/models/key-usage` route.
 */
function matchAnthropicAccount(
	accounts: ClaudeAccount[],
	keyId: string,
	credFile?: string,
): ClaudeAccount | undefined {
	const matched = accounts.find(
		(a) => a.id === keyId || (credFile != null && a.source === credFile),
	);
	return matched ?? accounts[0];
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

/** Human-readable coarse duration, e.g. "3h 12m", "5d 8h", "0m". */
function formatDuration(ms: number): string {
	const totalSec = Math.round(Math.abs(ms) / 1000);
	const days = Math.floor(totalSec / 86400);
	const hours = Math.floor((totalSec % 86400) / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
	return parts.join(" ");
}

function formatRelative(targetMs: number, nowMs: number): string {
	const delta = targetMs - nowMs;
	return delta >= 0 ? `in ${formatDuration(delta)}` : `${formatDuration(delta)} ago`;
}

function formatWindow(window: UsageWindow, now: number): string {
	const parts: string[] = [];
	if (typeof window.remainingPercent === "number") {
		parts.push(`${window.remainingPercent}% remaining`);
	}
	if (typeof window.resetsAt === "number") {
		parts.push(`resets ${iso(window.resetsAt)} (${formatRelative(window.resetsAt, now)})`);
	}
	return `${window.label}: ${parts.join(", ")}`;
}

/**
 * Render normalized usage entries into an AI-friendly text block. Pure — `now`
 * is injected so relative timestamps are deterministic under test.
 */
export function formatKeyUsage(entries: KeyUsageEntry[], now: number): string {
	if (entries.length === 0) return "No API keys matched.";

	const lines: string[] = [];
	lines.push(`API key usage — ${entries.length} key${entries.length === 1 ? "" : "s"}:`);

	for (const entry of entries) {
		lines.push("");
		lines.push(`[${entry.keyId}] provider: ${entry.provider}`);

		if (entry.status === "exhausted") {
			const since =
				typeof entry.exhaustedAt === "number"
					? ` (since ${iso(entry.exhaustedAt)}, ${formatRelative(entry.exhaustedAt, now)})`
					: "";
			lines.push(`status: EXHAUSTED${since}`);
			if (entry.lastError) lines.push(`last error: ${entry.lastError}`);
		} else {
			lines.push("status: active");
		}

		if (entry.unsupported) {
			lines.push(
				`usage: not supported for provider "${entry.provider}" (only anthropic and opencode-go report usage)`,
			);
			continue;
		}

		if (entry.dataSource === "live") {
			lines.push("data: live (fetched just now)");
		} else if (entry.dataSource === "cache") {
			lines.push(
				typeof entry.cachedAt === "number"
					? `data: cached — last fetched from source ${iso(entry.cachedAt)} (${formatRelative(entry.cachedAt, now)})`
					: "data: cached (source timestamp unknown)",
			);
		}

		for (const window of entry.windows) {
			lines.push(formatWindow(window, now));
		}

		if (entry.unavailableReason) {
			lines.push(`usage: unavailable — ${entry.unavailableReason}`);
		}
	}

	return lines.join("\n");
}

async function buildEntry(
	key: KeyState,
	accounts: ClaudeAccount[],
	fetchAnthropic: (account: ClaudeAccount) => Promise<ClaudeUsageResult | null>,
	fetchOpencode: (keyId: string) => Promise<OpencodeUsageReport | null>,
): Promise<KeyUsageEntry> {
	const def = key.definition;
	const entry: KeyUsageEntry = {
		keyId: def.id,
		provider: def.provider,
		status: key.status,
		windows: [],
		...(key.lastError ? { lastError: key.lastError } : {}),
		...(typeof key.exhaustedAt === "number" ? { exhaustedAt: key.exhaustedAt } : {}),
	};

	if (def.provider === "anthropic") {
		const account = matchAnthropicAccount(accounts, def.id, def.credentials_file);
		if (!account) {
			entry.unavailableReason = "no Claude account credentials available for this key";
			return entry;
		}
		let result: ClaudeUsageResult | null = null;
		try {
			result = await fetchAnthropic(account);
		} catch {
			result = null;
		}
		if (!result) {
			entry.unavailableReason = "no live usage data and no cached usage available";
			return entry;
		}
		entry.dataSource = result.source;
		if (typeof result.cachedAt === "number") entry.cachedAt = result.cachedAt;
		entry.windows = anthropicWindows(result.report);
		if (entry.windows.length === 0) {
			entry.unavailableReason = "usage endpoint returned no window data";
		}
		return entry;
	}

	if (def.provider === "opencode-go") {
		let report: OpencodeUsageReport | null = null;
		try {
			report = await fetchOpencode(def.id);
		} catch {
			report = null;
		}
		if (!report) {
			entry.unavailableReason =
				"live usage unavailable (requires OPENCODE_COOKIE and a workspace id, or the source returned no data; OpenCode keeps no local cache)";
			return entry;
		}
		entry.dataSource = "live";
		entry.windows = opencodeWindows(report);
		if (entry.windows.length === 0) {
			entry.unavailableReason = "usage source returned no window data";
		}
		return entry;
	}

	entry.unsupported = true;
	return entry;
}

export function createKeyUsageTool(callbacks: KeyUsageCallbacks): ToolDefinition {
	const fetchAnthropic = callbacks.fetchAnthropicUsage ?? getAccountUsageWithSource;
	const fetchOpencode = callbacks.fetchOpencodeUsage ?? defaultFetchOpencodeUsage;

	return {
		name: "key_usage",
		description: [
			"Report current usage levels for configured API keys so you can pick a key with",
			"headroom, warn before hitting a rate limit, or diagnose an exhausted-key failure.",
			"",
			"For each key it returns: provider, active/exhausted status (with the last error when",
			"exhausted), remaining rate-limit headroom per window (5-hour, weekly, and monthly where",
			"the provider exposes it), each window's reset timestamp, and whether the figures are",
			"live or served from cache (with the cache's last-fetched time).",
			"",
			"Pass a key_id to inspect one key; omit it to report all keys. Usage reporting is",
			"supported for anthropic and opencode-go keys.",
		].join("\n"),
		parameters: z.object({
			key_id: z
				.string()
				.optional()
				.describe(
					'The id of a single key to report (as configured in dispatch.toml, e.g. "claude-max"). Omit to report all configured keys.',
				),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const requestedKeyId = (args.key_id as string | undefined)?.trim() || undefined;

			const allKeys = callbacks.listKeys();
			if (allKeys.length === 0) {
				return "No API keys are configured.";
			}

			let keys = allKeys;
			if (requestedKeyId) {
				keys = allKeys.filter((k) => k.definition.id === requestedKeyId);
				if (keys.length === 0) {
					const available = allKeys.map((k) => k.definition.id).join(", ");
					return `Error: no key found with id "${requestedKeyId}". Available keys: ${available}.`;
				}
			}

			const accounts = callbacks.listClaudeAccounts();
			const entries: KeyUsageEntry[] = [];
			for (const key of keys) {
				entries.push(await buildEntry(key, accounts, fetchAnthropic, fetchOpencode));
			}

			return formatKeyUsage(entries, Date.now());
		},
	};
}
