/**
 * Wire-level request restructuring for the Claude OAuth (Pro/Max) flow.
 *
 * Anthropic validates the `system` array on OAuth-authenticated, Claude-Code-
 * billed requests. A genuine Claude Code request looks like:
 *
 *   system: [
 *     { type: "text", text: "x-anthropic-billing-header: ..." },   // system[0], NO cache_control
 *     { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.",
 *       cache_control: { type: "ephemeral" } },                    // identity, separate block
 *   ]
 *   messages: [ { role: "user", content: "<the real system prompt>\n\n<user text>" }, ... ]
 *
 * i.e. ONLY the billing header and the verbatim identity string may live in
 * `system[]`. Any third-party system prompt (Dispatch's tool/agent instructions)
 * MUST be relocated into the first user message. When third-party content stays
 * in `system[]` next to the identity, Anthropic bills it as premium "extra
 * usage" (token burn) and refuses to apply the Claude Code prompt-cache scope —
 * producing the 0% cache hit rate and ballooning cost we were seeing.
 *
 * Dispatch builds its system prompt as ONE concatenated block
 * (`<billing>\n<identity>\n\n<systemPrompt>`); `@ai-sdk/anthropic` serializes
 * that into a single `system[]` text entry. This transform runs at fetch time
 * on the already-serialized JSON body and reshapes it into the structure above.
 *
 * Mirrors `references/opencode-claude-auth/src/transforms.ts` (`transformBody`),
 * adapted to Dispatch: tool names are already PascalCase-`mcp_`-prefixed by the
 * agent, so this transform leaves tools and messages (other than the relocation)
 * untouched. It is defensive: any parse/shape surprise returns the body
 * unchanged so a transform bug can never break a request.
 */

const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const BILLING_PREFIX = "x-anthropic-billing-header";

type SystemBlock = { type: "text"; text: string; cache_control?: unknown } & Record<
	string,
	unknown
>;

interface AnthropicRequestBody {
	system?: string | Array<{ type?: string; text?: string } & Record<string, unknown>>;
	messages?: Array<{
		role?: string;
		content?: string | Array<{ type?: string; text?: string } & Record<string, unknown>>;
	}>;
	[key: string]: unknown;
}

/**
 * Restructure a serialized Anthropic request body string for the Claude Code
 * OAuth flow. Returns the (possibly rewritten) body, or the original input
 * unchanged when it isn't a JSON string we recognize.
 */
export function transformClaudeOAuthBody(
	body: BodyInit | null | undefined,
): BodyInit | null | undefined {
	if (typeof body !== "string") return body;
	let parsed: AnthropicRequestBody;
	try {
		parsed = JSON.parse(body) as AnthropicRequestBody;
	} catch {
		return body;
	}
	if (!parsed || typeof parsed !== "object") return body;
	try {
		const changed = restructureSystem(parsed);
		return changed ? JSON.stringify(parsed) : body;
	} catch {
		// Never let a transform bug break a real request.
		return body;
	}
}

/**
 * In-place restructure of `parsed.system` / `parsed.messages`. Returns true if
 * anything changed (so the caller knows to re-serialize).
 */
function restructureSystem(parsed: AnthropicRequestBody): boolean {
	const raw = parsed.system;
	let entries: SystemBlock[];
	if (typeof raw === "string") {
		entries = [{ type: "text", text: raw }];
	} else if (Array.isArray(raw)) {
		entries = raw.map((e) =>
			typeof e === "string"
				? { type: "text", text: e }
				: ({ ...e, type: "text", text: typeof e.text === "string" ? e.text : "" } as SystemBlock),
		);
	} else {
		return false; // no system field — nothing to do
	}

	const combined = entries.map((e) => e.text).join("\n\n");

	// Only act on Claude Code shaped requests (must carry the identity string).
	if (!combined.includes(SYSTEM_IDENTITY)) return false;

	const hadCacheControl = entries.some((e) => e.cache_control != null);

	// Peel the billing-header line out (it is a single line with no newlines).
	const lines = combined.split("\n");
	const billingIdx = lines.findIndex((l) => l.startsWith(BILLING_PREFIX));
	let billingLine: string | null = null;
	if (billingIdx !== -1) {
		billingLine = lines[billingIdx] ?? null;
		lines.splice(billingIdx, 1);
	}
	const afterBilling = lines.join("\n").replace(/^\n+/, "");

	// Split the identity prefix from the rest (Dispatch's real system prompt).
	let rest = "";
	if (afterBilling.startsWith(SYSTEM_IDENTITY)) {
		rest = afterBilling.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "");
	} else {
		// Identity is present but not at the front (unexpected) — still isolate it.
		rest = afterBilling.replace(SYSTEM_IDENTITY, "").replace(/^\n+/, "");
	}

	// Rebuild system[]: billing (no cache_control) then identity (cached).
	const newSystem: SystemBlock[] = [];
	if (billingLine) newSystem.push({ type: "text", text: billingLine });
	const identityBlock: SystemBlock = { type: "text", text: SYSTEM_IDENTITY };
	if (hadCacheControl) identityBlock.cache_control = { type: "ephemeral" };
	newSystem.push(identityBlock);

	// Relocate the third-party system prompt into the first user message.
	if (rest.length > 0) {
		const firstUser = Array.isArray(parsed.messages)
			? parsed.messages.find((m) => m.role === "user")
			: undefined;
		if (firstUser) {
			if (typeof firstUser.content === "string") {
				firstUser.content = `${rest}\n\n${firstUser.content}`;
			} else if (Array.isArray(firstUser.content)) {
				firstUser.content.unshift({ type: "text", text: rest });
			} else {
				firstUser.content = rest;
			}
		} else {
			// No user message to host it — keep it as a (cached) system block so
			// the request still carries the instructions.
			const restBlock: SystemBlock = { type: "text", text: rest };
			if (hadCacheControl) restBlock.cache_control = { type: "ephemeral" };
			newSystem.push(restBlock);
		}
	}

	parsed.system = newSystem;
	return true;
}

export const __test = { restructureSystem, SYSTEM_IDENTITY, BILLING_PREFIX };
