# Tool Schema Analysis — Dispatch / AI SDK v6

## How Dispatch Defines Tools

Dispatch uses the **AI SDK v6** (`ai@^6.0.191`) with provider adapters (`@ai-sdk/anthropic@^3.0.79`, `@ai-sdk/openai-compatible@^2.0.48`).

### The conversion pipeline

```
Zod schema (z.object({...}))
  → zodToJsonSchema()   → JSON Schema Draft 7
  → jsonSchema()         → AI SDK v6 inputSchema wrapper
  → tool()               → AI SDK v6 Tool object (no execute fn)
  → streamText({tools})  → SDK → provider adapter → wire format
```

**Critical file:** `packages/core/src/tools/registry.ts` — the `toAISDKTool()` function.

### What each tool's schema looks like after conversion

For a typical tool like `read_file`:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to the file..." },
    "offset": { "type": "integer", "minimum": 1, "description": "..." },
    "limit": { "type": "integer", "minimum": 1, "description": "..." }
  },
  "required": ["path"],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

### The Problem Surface

The `zodToJsonSchema()` library (v3.x) generates full Draft 7 JSON Schema including:

1. **`$schema` field** — `"http://json-schema.org/draft-07/schema#"` — Anthropic's API rejects this or silently ignores it depending on version
2. **`additionalProperties: false`** — Anthropic may not handle this correctly; Claude's `tool_use` blocks sometimes include extra fields
3. **`default` values** — Zod schemas with `.default()` produce JSON Schema `default` fields that Anthropic doesn't support
4. **`minimum`/`maximum`** — Numeric constraints may cause issues if Claude passes values slightly outside bounds

### What the oh-my-pi reference does differently

The `references/oh-my-pi/packages/ai/src/utils/schema/normalize.ts` shows a `normalizeSchemaForCCA()` function that strips all of the above. Dispatch does **no normalization** before passing schemas to the AI SDK.

### What the AI SDK's @ai-sdk/anthropic adapter does

The adapter should convert the AI SDK's internal format to Anthropic's wire format. However, the adapter may:
- Pass through JSON Schema fields that Anthropic doesn't support (like `$schema`, `additionalProperties`)
- Not add parameter `description` fields from the schema to the Anthropic format
- Not handle `default` values correctly

### Files to inspect

| File | What to check |
|------|---------------|
| `node_modules/@ai-sdk/anthropic/dist/index.mjs` | How tools are serialized for the wire |
| `node_modules/ai/dist/index.mjs` | How `tool()` and `jsonSchema()` work |
| `node_modules/zod-to-json-schema/dist/` | What `zodToJsonSchema` outputs for our schemas |
