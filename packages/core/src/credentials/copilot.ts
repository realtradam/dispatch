// ─── GitHub Copilot Usage Tracking ───────────────────────────
// Uses the internal GitHub Copilot user endpoint (same one the
// official VS Code Copilot extension calls).

export interface CopilotUsageReport {
	tokensConsumed?: number;
	tokensRemaining?: number;
	percentUsed?: number; // 0-100
	resetAt?: number; // Unix timestamp ms
	plan?: string;
}

export async function fetchCopilotUsage(
	token: string,
	_baseUrl: string,
): Promise<CopilotUsageReport | null> {
	const url = "https://api.github.com/copilot_internal/user";
	const headers: Record<string, string> = {
		authorization: `Bearer ${token}`,
		accept: "application/json",
	};

	try {
		const response = await fetch(url, { headers });
		if (!response.ok) return null;

		const data = (await response.json()) as Record<string, unknown>;
		const plan = typeof data.copilot_plan === "string" ? data.copilot_plan : undefined;

		const resetDate = typeof data.quota_reset_date === "string" ? data.quota_reset_date : undefined;
		const resetAt = resetDate ? Date.parse(resetDate) : undefined;

		const qs = data.quota_snapshots as Record<string, unknown> | undefined;
		const pi = qs?.premium_interactions as Record<string, unknown> | undefined;

		const entitlement = typeof pi?.entitlement === "number" ? pi.entitlement : undefined;
		const remaining = typeof pi?.remaining === "number" ? pi.remaining : undefined;
		const percentRemaining =
			typeof pi?.percent_remaining === "number" ? pi.percent_remaining : undefined;

		if (entitlement === undefined && remaining === undefined) {
			return null;
		}

		const tokensConsumed =
			entitlement !== undefined && remaining !== undefined ? entitlement - remaining : undefined;
		const percentUsed =
			percentRemaining !== undefined
				? Math.round((100 - percentRemaining) * 100) / 100
				: tokensConsumed !== undefined && entitlement !== undefined && entitlement > 0
					? Math.round((tokensConsumed / entitlement) * 10000) / 100
					: undefined;

		return {
			tokensConsumed,
			tokensRemaining: remaining,
			percentUsed,
			resetAt: resetAt && !Number.isNaN(resetAt) ? resetAt : undefined,
			plan,
		};
	} catch {
		return null;
	}
}
