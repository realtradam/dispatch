import { describe, expect, it, vi } from "vitest";

// The tool imports `getAccountUsageWithSource` from `claude.ts`, which
// transitively imports `db/index.js` (top-level `import { Database } from
// "bun:sqlite"`) — unresolvable under vitest's Node runtime. These tests inject
// stub fetchers and never hit the real fetchers/DB, so stubbing the db module
// is enough to let the import chain resolve.
vi.mock("../../src/db/index.js", () => ({
	getDatabase: vi.fn(() => {
		throw new Error("db not available in this test");
	}),
}));

import type { ClaudeAccount, ClaudeUsageResult } from "../../src/credentials/claude.js";
import type { OpencodeUsageReport } from "../../src/credentials/opencode.js";
import {
	createKeyUsageTool,
	formatKeyUsage,
	type KeyUsageCallbacks,
} from "../../src/tools/key-usage.js";
import type { KeyDefinition, KeyState } from "../../src/types/index.js";

// ─── Builders ─────────────────────────────────────────────────

function keyState(
	def: Partial<KeyDefinition> & { id: string; provider: string },
	overrides: Partial<Omit<KeyState, "definition">> = {},
): KeyState {
	return {
		definition: { base_url: "https://example.test", ...def },
		status: "active",
		...overrides,
	};
}

function account(id: string, source = `/creds/${id}.json`): ClaudeAccount {
	return {
		id,
		label: id,
		source,
		credentials: { accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 },
	};
}

/** Build the tool with explicit stub fetchers — no network, no DB. */
function buildTool(opts: {
	keys: KeyState[];
	accounts?: ClaudeAccount[];
	anthropic?: (a: ClaudeAccount) => Promise<ClaudeUsageResult | null>;
	opencode?: (keyId: string) => Promise<OpencodeUsageReport | null>;
}) {
	const callbacks: KeyUsageCallbacks = {
		listKeys: () => opts.keys,
		listClaudeAccounts: () => opts.accounts ?? [],
		fetchAnthropicUsage: opts.anthropic ?? (async () => null),
		fetchOpencodeUsage: opts.opencode ?? (async () => null),
	};
	return createKeyUsageTool(callbacks);
}

const HOUR = 3_600_000;

describe("key_usage tool", () => {
	it("reports all keys when no key_id is given", async () => {
		const reset5h = Date.now() + 2 * HOUR;
		const tool = buildTool({
			keys: [
				keyState({ id: "claude-max", provider: "anthropic", credentials_file: "/creds/max.json" }),
				keyState({ id: "opencode-1", provider: "opencode-go" }),
			],
			accounts: [account("claude-max", "/creds/max.json")],
			anthropic: async () => ({
				source: "live",
				report: {
					fiveHour: { utilization: 0.25, resetsAt: reset5h },
					sevenDay: { utilization: 0.6 },
				},
			}),
			opencode: async () => ({
				fiveHour: { utilization: 0.1 },
				weekly: { utilization: 0.4 },
				monthly: { utilization: 0.7 },
			}),
		});

		const out = await tool.execute({});

		// Both keys present with providers.
		expect(out).toContain("[claude-max] provider: anthropic");
		expect(out).toContain("[opencode-1] provider: opencode-go");
		// Remaining = (1 - utilization) * 100.
		expect(out).toContain("5-hour: 75% remaining");
		expect(out).toContain("week: 40% remaining");
		expect(out).toContain("5-hour: 90% remaining");
		expect(out).toContain("week: 60% remaining");
		expect(out).toContain("month: 30% remaining");
		expect(out).toContain("data: live (fetched just now)");
	});

	it("filters to a single key when key_id is given and does not fetch others", async () => {
		const opencodeFetch = vi.fn(async () => ({ fiveHour: { utilization: 0.5 } }));
		const tool = buildTool({
			keys: [
				keyState({ id: "claude-max", provider: "anthropic" }),
				keyState({ id: "opencode-1", provider: "opencode-go" }),
			],
			accounts: [account("claude-max")],
			anthropic: async () => ({
				source: "live",
				report: { fiveHour: { utilization: 0.2 } },
			}),
			opencode: opencodeFetch,
		});

		const out = await tool.execute({ key_id: "claude-max" });

		expect(out).toContain("[claude-max] provider: anthropic");
		expect(out).not.toContain("opencode-1");
		expect(opencodeFetch).not.toHaveBeenCalled();
	});

	it("returns a helpful error for an unknown key_id", async () => {
		const tool = buildTool({
			keys: [
				keyState({ id: "claude-max", provider: "anthropic" }),
				keyState({ id: "opencode-1", provider: "opencode-go" }),
			],
		});

		const out = await tool.execute({ key_id: "nope" });

		expect(out).toContain('no key found with id "nope"');
		expect(out).toContain("claude-max");
		expect(out).toContain("opencode-1");
	});

	it("reports cached data with the source's last-fetched timestamp", async () => {
		const cachedAt = Date.UTC(2025, 0, 2, 3, 4, 5);
		const tool = buildTool({
			keys: [keyState({ id: "claude-max", provider: "anthropic" })],
			accounts: [account("claude-max")],
			anthropic: async () => ({
				source: "cache",
				cachedAt,
				report: { fiveHour: { utilization: 0.5 } },
			}),
		});

		const out = await tool.execute({});

		expect(out).toContain("data: cached — last fetched from source 2025-01-02T03:04:05.000Z");
		expect(out).toContain("5-hour: 50% remaining");
	});

	it("omits the month window for anthropic (no monthly bucket)", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "claude-max", provider: "anthropic" })],
			accounts: [account("claude-max")],
			anthropic: async () => ({
				source: "live",
				report: { fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.2 } },
			}),
		});

		const out = await tool.execute({});

		expect(out).toContain("5-hour:");
		expect(out).toContain("week:");
		expect(out).not.toContain("month:");
	});

	it("includes the month window for opencode-go", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "opencode-1", provider: "opencode-go" })],
			opencode: async () => ({
				fiveHour: { utilization: 0.1 },
				weekly: { utilization: 0.2 },
				monthly: { utilization: 0.3 },
			}),
		});

		const out = await tool.execute({});

		expect(out).toContain("month: 70% remaining");
	});

	it("surfaces exhausted status with the last error", async () => {
		const exhaustedAt = Date.now() - HOUR;
		const tool = buildTool({
			keys: [
				keyState(
					{ id: "opencode-1", provider: "opencode-go" },
					{ status: "exhausted", lastError: "429 rate limit exceeded", exhaustedAt },
				),
			],
			opencode: async () => null,
		});

		const out = await tool.execute({});

		expect(out).toContain("status: EXHAUSTED");
		expect(out).toContain("last error: 429 rate limit exceeded");
	});

	it("flags providers without usage support", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "gem", provider: "google" })],
		});

		const out = await tool.execute({});

		expect(out).toContain("[gem] provider: google");
		expect(out).toContain("not supported");
	});

	it("reports unavailable when a supported provider returns no usage", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "claude-max", provider: "anthropic" })],
			accounts: [account("claude-max")],
			anthropic: async () => null,
		});

		const out = await tool.execute({});

		expect(out).toContain("usage: unavailable");
		expect(out).toContain("no cached usage");
	});

	it("reports unavailable for anthropic keys with no account credentials", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "claude-max", provider: "anthropic" })],
			accounts: [],
		});

		const out = await tool.execute({});

		expect(out).toContain("no Claude account credentials available");
	});

	it("treats a fetcher that throws as unavailable (does not crash)", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "opencode-1", provider: "opencode-go" })],
			opencode: async () => {
				throw new Error("network down");
			},
		});

		const out = await tool.execute({});

		expect(out).toContain("usage: unavailable");
	});

	it("reports when no keys are configured at all", async () => {
		const tool = buildTool({ keys: [] });
		const out = await tool.execute({});
		expect(out).toBe("No API keys are configured.");
	});

	it("clamps out-of-range utilization to 0–100%", async () => {
		const tool = buildTool({
			keys: [keyState({ id: "opencode-1", provider: "opencode-go" })],
			opencode: async () => ({
				fiveHour: { utilization: 1.2 }, // over 100% used → 0% remaining
				weekly: { utilization: -0.5 }, // negative → 100% remaining
			}),
		});

		const out = await tool.execute({});

		expect(out).toContain("5-hour: 0% remaining");
		expect(out).toContain("week: 100% remaining");
	});
});

describe("formatKeyUsage (pure)", () => {
	const now = Date.UTC(2025, 5, 1, 12, 0, 0);

	it("formats reset timestamps with ISO + relative time", () => {
		const out = formatKeyUsage(
			[
				{
					keyId: "claude-max",
					provider: "anthropic",
					status: "active",
					dataSource: "live",
					windows: [{ label: "5-hour", remainingPercent: 80, resetsAt: now + 90 * 60_000 }],
				},
			],
			now,
		);

		expect(out).toContain("5-hour: 80% remaining, resets 2025-06-01T13:30:00.000Z (in 1h 30m)");
	});

	it("renders a past reset/exhaustion time as 'ago'", () => {
		const out = formatKeyUsage(
			[
				{
					keyId: "opencode-1",
					provider: "opencode-go",
					status: "exhausted",
					exhaustedAt: now - 2 * HOUR,
					lastError: "boom",
					windows: [],
				},
			],
			now,
		);

		expect(out).toContain("status: EXHAUSTED (since 2025-06-01T10:00:00.000Z, 2h ago)");
		expect(out).toContain("last error: boom");
	});

	it("returns a friendly message when no entries match", () => {
		expect(formatKeyUsage([], now)).toBe("No API keys matched.");
	});
});
