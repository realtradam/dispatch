// ─── Anthropic Beta Headers ───────────────────────────────────
//
// The set of `anthropic-beta` features the official Claude Code CLI sends on
// every request. Kept in a dependency-free module (no DB / `bun:sqlite`
// import) so the LLM provider layer (`llm/provider.ts`) can pull the list in
// without dragging the whole credentials/DB stack into its import graph.
//
// `prompt-caching-scope-2026-01-05` is load-bearing for cost: without it the
// Anthropic API silently ignores every `cache_control` breakpoint we place,
// producing a 0% cache hit rate (see notes/claude-report.md). `oauth-2025-04-20`
// gates the Bearer/OAuth flow used by Claude Pro/Max subscriptions.

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
