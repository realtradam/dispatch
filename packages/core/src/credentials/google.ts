// ─── Google Gemini Usage Tracking ───────────────────────────
// Two modes:
// 1. API key → queries native Gemini models endpoint for rate limits
// 2. Cookie → scrapes gemini.google.com for current usage % (like OpenCode)
//
// Set GEMINI_COOKIE env var with the value of your __Secure-1PSID cookie
// from gemini.google.com to see current usage percentages.

export interface GoogleUsageBucket {
	percentUsed: number; // 0-100
	resetsAt?: string; // e.g. "22:40" or "30 May at 17:40"
}

export interface GoogleUsageReport {
	// Mode 1: API key rate limits
	models?: Array<{
		name: string;
		inputTokenLimit: number;
		outputTokenLimit: number;
		rpm: number;
		requestsPerDay: number;
	}>;
	// Mode 2: Cookie-scraped usage from gemini.google.com
	currentUsage?: GoogleUsageBucket;
	weeklyUsage?: GoogleUsageBucket;
}

// Helpers to extract HTML text between markers
function extractBetween(html: string, after: string, before: string): string | null {
	const start = html.indexOf(after);
	if (start === -1) return null;
	const s = start + after.length;
	const end = html.indexOf(before, s);
	if (end === -1) return null;
	return html.slice(s, end).trim();
}

function extractPercent(html: string, afterMarker: string): number | null {
	const chunk = extractBetween(html, afterMarker, "%");
	if (!chunk) return null;
	const digits = chunk.replace(/\D/g, "");
	const n = parseInt(digits, 10);
	return Number.isNaN(n) ? null : n;
}

function extractResetTime(html: string, afterMarker: string): string | null {
	// Look for "Resets at HH:MM" or "Resets on DD Mon at HH:MM"
	const start = html.indexOf(afterMarker);
	if (start === -1) return null;
	const chunk = html.slice(start + afterMarker.length);
	// Match time patterns
	const m = chunk.match(/Resets?\s+(at|on)\s+([^<]+)/i);
	if (!m?.[1] || !m[2]) return null;
	return `${m[1]} ${m[2].trim()}`;
}

async function scrapeGeminiWeb(cookie: string): Promise<{
	currentUsage?: GoogleUsageBucket;
	weeklyUsage?: GoogleUsageBucket;
} | null> {
	try {
		const response = await fetch("https://gemini.google.com/app", {
			headers: {
				cookie: `__Secure-1PSID=${cookie}`,
				"accept-language": "en-US,en;q=0.9",
			},
			redirect: "follow",
		});

		if (!response.ok) return null;

		const html = await response.text();

		// Detect auth redirect
		if (html.includes("ServiceLogin") || html.includes("sign in")) {
			return null;
		}

		// Look for usage data in the page
		// Pattern: "Current usage" followed by a percentage and reset time
		const currentPct = extractPercent(html, "Current usage");
		const currentReset = extractResetTime(html, "Current usage");

		// Weekly limit section
		const weeklyPct = extractPercent(html, "Weekly limit");
		const weeklyReset = extractResetTime(html, "Weekly limit");

		const result: {
			currentUsage?: GoogleUsageBucket;
			weeklyUsage?: GoogleUsageBucket;
		} = {};

		if (currentPct !== null) {
			result.currentUsage = {
				percentUsed: currentPct,
				resetsAt: currentReset ?? undefined,
			};
		}

		if (weeklyPct !== null) {
			result.weeklyUsage = {
				percentUsed: weeklyPct,
				resetsAt: weeklyReset ?? undefined,
			};
		}

		if (result.currentUsage || result.weeklyUsage) return result;
		return null;
	} catch {
		return null;
	}
}

async function fetchModelsViaApiKey(apiKey: string): Promise<Array<{
	name: string;
	inputTokenLimit: number;
	outputTokenLimit: number;
	rpm: number;
	requestsPerDay: number;
}> | null> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;

	try {
		const response = await fetch(url);
		if (!response.ok) return null;

		const data = (await response.json()) as {
			models?: Array<{
				name: string;
				inputTokenLimit?: number;
				outputTokenLimit?: number;
				rateLimit?: { requestsPerMinute?: number };
				limits?: { requestsPerDay?: number };
			}>;
		};

		return (data.models ?? [])
			.filter((m) => {
				const name = m.name?.replace(/^models\//, "") ?? "";
				return name.startsWith("gemini-");
			})
			.map((m) => ({
				name: m.name?.replace(/^models\//, "") ?? "",
				inputTokenLimit: m.inputTokenLimit ?? 0,
				outputTokenLimit: m.outputTokenLimit ?? 0,
				rpm: m.rateLimit?.requestsPerMinute ?? 0,
				requestsPerDay: m.limits?.requestsPerDay ?? 0,
			}));
	} catch {
		return null;
	}
}

export async function fetchGoogleUsage(
	apiKey: string,
	_baseUrl: string,
): Promise<GoogleUsageReport | null> {
	const results: GoogleUsageReport = {};

	// Try API key mode: get model rate limits
	const models = await fetchModelsViaApiKey(apiKey);
	if (models) {
		results.models = models;
	}

	// Try cookie mode: scrape gemini.google.com usage
	const cookie = process.env.GEMINI_COOKIE;
	if (cookie) {
		const scraped = await scrapeGeminiWeb(cookie);
		if (scraped) {
			if (scraped.currentUsage) results.currentUsage = scraped.currentUsage;
			if (scraped.weeklyUsage) results.weeklyUsage = scraped.weeklyUsage;
		}
	}

	if (results.models || results.currentUsage || results.weeklyUsage) return results;
	return null;
}
