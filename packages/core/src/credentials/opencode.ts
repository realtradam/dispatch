import { resolveApiKey } from "./api-keys.js";

// ─── OpenCode Usage Tracking ──────────────────────────────────
// OpenCode has no public usage API. We scrape usage from the
// SolidStart SSR-rendered workspace page using a session cookie.
// Requires OPENCODE_COOKIE env var.
// Workspace IDs: OPENCODE_WS1_ID for opencode-1, OPENCODE_WS2_ID for opencode-2.

export interface OpencodeUsageBucket {
	utilization?: number; // 0-1 fraction
	resetsAt?: number; // Unix timestamp ms
}

export interface OpencodeUsageReport {
	fiveHour?: OpencodeUsageBucket;
	weekly?: OpencodeUsageBucket;
	monthly?: OpencodeUsageBucket;
}

function getWorkspaceId(keyId: string): string | undefined {
	// Check DB for workspace ID: stored as "opencode-ws1", "opencode-ws2", or "opencode-ws"
	const match = keyId.match(/opencode-(\d+)$/i);
	if (match) {
		const num = match[1];
		const specific = resolveApiKey(`opencode-ws${num}`);
		if (specific) return specific;
	}
	return resolveApiKey("opencode-ws") ?? undefined;
}

function parseOcDouble(html: string, key: string): number {
	const idx = html.indexOf(`${key}:`);
	if (idx === -1) return 0;
	let start = idx + key.length + 1;
	while (start < html.length && html[start] === " ") start++;
	let end = start;
	while (end < html.length && html[end] !== "," && html[end] !== "}") {
		end++;
	}
	const val = parseFloat(html.slice(start, end));
	return Number.isNaN(val) ? 0 : val;
}

function parseOcInt(html: string, key: string): number {
	const idx = html.indexOf(`${key}:`);
	if (idx === -1) return 0;
	let i = idx + key.length + 1;
	while (i < html.length && html[i] === " ") i++;
	return parseInt(html.slice(i), 10) || 0;
}

function parseOcBucket(
	html: string,
	bucketName: string,
): { utilization: number; resetsAt: number } | null {
	const search = `${bucketName}:`;
	const pos = html.indexOf(search);
	if (pos === -1) return null;

	// Find the opening brace after the bucket name
	const brace = html.indexOf("{", pos);
	if (brace === -1) return null;

	const resetSecs = parseOcInt(html.slice(brace), "resetInSec");
	const usagePct = parseOcDouble(html.slice(brace), "usagePercent");

	const utilization = usagePct / 100; // convert 0-100% to 0-1 fraction
	const resetsAt = Date.now() + resetSecs * 1000;

	return { utilization, resetsAt };
}

export async function fetchOpencodeUsage(keyId: string): Promise<OpencodeUsageReport | null> {
	const cookie = resolveApiKey("opencode-cookie");
	const wsId = getWorkspaceId(keyId);

	if (!cookie || !wsId) {
		return null;
	}

	const url = `https://opencode.ai/workspace/${encodeURIComponent(wsId)}/go`;

	try {
		const response = await fetch(url, {
			headers: {
				accept: "text/html",
				cookie: `auth=${cookie}`,
			},
			redirect: "follow",
		});

		if (!response.ok) return null;

		const html = await response.text();

		// Auth redirect check
		if (html.includes("/auth/authorize") || html.includes('window.location="/auth/authorize"')) {
			return null;
		}

		// Find the lite.subscription data block.
		// HTML contains: lite.subscription.get[\"<wsId>\"]
		// We need literal backslashes; use \x5c (hex for backslash).
		const wsKey = `lite.subscription.get[\x5c"${wsId}\x5c"]`;
		const wsPos = html.indexOf(wsKey);
		if (wsPos === -1) return null;

		// Search for the resolved data starting from the ws key position
		const minePos = html.indexOf("mine:", wsPos);
		const slice = minePos !== -1 ? html.slice(minePos) : "";

		const fiveHour = parseOcBucket(slice, "rollingUsage");
		const weekly = parseOcBucket(slice, "weeklyUsage");
		const monthly = parseOcBucket(slice, "monthlyUsage");

		if (!fiveHour && !weekly && !monthly) return null;

		return {
			fiveHour: fiveHour ?? undefined,
			weekly: weekly ?? undefined,
			monthly: monthly ?? undefined,
		};
	} catch {
		return null;
	}
}
