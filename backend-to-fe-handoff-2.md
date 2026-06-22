# Backend → FE handoff — context window + percentage-based compact

> Courier to `../dispatch-web`. Response to the context-window ask in
> `backend-handoff.md` §3 + compacting rework.

## What shipped

1. **`GET /models` now includes `contextWindow` per model** — the FE can replace
   the hardcoded `MAX_CONTEXT = 1,000,000` with the real value.
2. **Auto-compact is now percentage-based** (default 85% of `contextWindow`)
   instead of a flat token count (was 350k).

## Bump pinned deps
- `@dispatch/wire` → `0.11.0` (unchanged)
- `@dispatch/transport-contract` → `0.15.0` (unchanged — the new types are
  additive to the existing version)

## `GET /models` — now includes `modelInfo`

The response now includes an optional `modelInfo` map alongside the existing
`models` array. The `models` array is unchanged (backward compatible).

```ts
interface ModelsResponse {
  readonly models: readonly string[];
  readonly modelInfo?: Readonly<Record<string, ModelMetadata>>;
}

interface ModelMetadata {
  readonly contextWindow?: number;  // max tokens (e.g. 200000)
}
```

**Example response:**
```json
{
  "models": ["opencode/deepseek-v4-flash", "umans/umans-glm-5.2"],
  "modelInfo": {
    "opencode/deepseek-v4-flash": { "contextWindow": 128000 },
    "umans/umans-glm-5.2": { "contextWindow": 200000 }
  }
}
```

`modelInfo` is absent when no provider reports `contextWindow`. Each key is the
same `<credentialName>/<model>` string from the `models` array.

**What the FE should do:**
- When rendering the composer status bar, use `modelInfo[selectedModel].contextWindow`
  as the denominator for `contextSize / contextWindow · pct%`.
- Fall back to the current hardcoded `1,000,000` when `modelInfo` is absent or
  the selected model has no `contextWindow`.

## Auto-compact: now percentage-based

**Old:** flat token threshold (default 350000). `contextSize >= threshold`.
**New:** percentage of `contextWindow` (default 85%). `contextSize >= contextWindow × (percent / 100)`.

Also fixed: the check now uses `contextSize` (true context occupancy = last
step's `inputTokens + outputTokens`) instead of the overcounted aggregate
`usage.inputTokens` (which summed every step's re-prefilled prompt).

### `GET /conversations/:id/compact-percent` — read percent

200: `CompactPercentResponse { conversationId, percent }`
- `percent: 0` — auto-compact explicitly disabled (manual only).
- `percent: null` (not stored) — **default: 85** (85% of the model's context window).
- Any positive number (1-100) — auto-compact triggers when `contextSize`
  exceeds `percent`% of the model's `contextWindow`.

### `PUT /conversations/:id/compact-percent` — set percent

Body: `SetCompactPercentRequest { percent: number }`
- `0` explicitly disables auto-compact.
- Any positive number (1-100) sets the trigger percentage.
- Default (when not stored) is 85.

200: `CompactPercentResponse`

**Renamed from `compact-threshold`** — the old endpoint paths, request types,
and response types are gone. Update any FE code that referenced
`compact-threshold`.

## New types

```ts
// @dispatch/transport-contract
export interface ModelMetadata {
  readonly contextWindow?: number;
}

// ModelsResponse now has modelInfo (additive — models array unchanged)
export interface ModelsResponse {
  readonly models: readonly string[];
  readonly modelInfo?: Readonly<Record<string, ModelMetadata>>;
}

// Renamed from CompactThresholdResponse
export interface CompactPercentResponse {
  readonly conversationId: string;
  readonly percent: number;  // 0 = manual; null = default 85
}

// Renamed from SetCompactThresholdRequest
export interface SetCompactPercentRequest {
  readonly percent: number;
}
```

## What the FE needs to do

1. **Use real `contextWindow`** from `GET /models` → `modelInfo[model].contextWindow`
   instead of hardcoded `MAX_CONTEXT = 1,000,000`.

2. **Rename compact-threshold → compact-percent** in any FE code:
   - `GET /conversations/:id/compact-percent` (was `compact-threshold`)
   - `PUT /conversations/:id/compact-percent` (was `compact-threshold`)
   - `percent` field (was `threshold`)

3. **Settings UI**: change the number input from "token count" to "percent
   (0-100)". Default 85. 0 = manual only.

4. **No other changes** — the compact endpoint, WS message, and chain
   architecture are unchanged.
