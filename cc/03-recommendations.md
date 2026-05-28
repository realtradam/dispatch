# Recommendations — Fixing Claude Opus Tool Calling

## 1. Add Anthropic Schema Normalization

**Problem:** `zodToJsonSchema()` generates Draft 7 JSON Schema with `$schema`, `additionalProperties`, and potentially `default` fields that Anthropic's API doesn't support.

**Fix:** Add a normalization step between `zodToJsonSchema()` and `jsonSchema()` in `packages/core/src/tools/registry.ts` that strips unsupported fields:

```typescript
function normalizeForAnthropic(schema: Record<string, unknown>): Record<string, unknown> {
    // Remove fields Anthropic doesn't support
    delete schema.$schema;
    delete schema.additionalProperties;
    delete schema.default;
    // Strip from nested properties too
    if (schema.properties && typeof schema.properties === 'object') {
        for (const key of Object.keys(schema.properties as Record<string, unknown>)) {
            const prop = (schema.properties as Record<string, unknown>)[key] as Record<string, unknown>;
            delete prop.$schema;
            delete prop.additionalProperties;
            delete prop.default;
        }
    }
    return schema;
}
```

**File to modify:** `packages/core/src/tools/registry.ts` — the `toAISDKTool()` function.

## 2. Verify @ai-sdk/anthropic Adapter Version

**Check:** `node_modules/@ai-sdk/anthropic/dist/index.mjs` — verify the adapter properly converts `input_schema` to Anthropic's `input_schema` format on the wire.

The AI SDK v6 adapter should handle this, but verify by looking at how it serializes tools. The key serialization happens in the adapter's `convertToolsToAnthropic()` or similar function.

## 3. Add `tool_choice: "any"` for Opus

**Problem:** Opus may decide not to call tools even when it should.

**Fix:** For Claude Opus sessions, consider setting `tool_choice: { type: "any" }` (or `"auto"`) to encourage tool use. Currently dispatch doesn't set any explicit `tool_choice` — the AI SDK default may be suboptimal.

In `packages/core/src/agent/agent.ts`, the `streamText` options don't include `toolChoice`. Consider adding it conditionally for anthropic provider:

```typescript
const streamOptions = {
    model,
    messages: coreMessages,
    tools,
    ...(isClaudeOAuth ? { toolChoice: "auto" } : {}),
};
```

## 4. Check Parameter Descriptions

**Problem:** All tools have `.describe()` on their parameters, but verify the AI SDK's Anthropic adapter is forwarding these descriptions to the Anthropic `input_schema.properties.*.description` field.

## 5. System Prompt Tool Instructions

The current system prompt in `agent-manager.ts` lists tools generically:
```
"You have access to the following tools:\n\n{tool_list}\n\nWhen asked to work with files, use these tools."
```

For Claude Opus, add more explicit instructions about WHEN to use each tool and that it SHOULD use tools rather than just talking about solutions.

## 6. Debugging: Log the Actual API Request

Add logging to see what's actually sent to Anthropic for the `tools` parameter. The most reliable way is to add a `fetch` wrapper or check the `@ai-sdk/anthropic` adapter's serialization.

Quick check:
```bash
node -e "
import { zodToJsonSchema } from 'zod-to-json-schema';
import { z } from 'zod';
const schema = z.object({
    path: z.string().describe('Path to the file'),
    offset: z.number().int().optional(),
});
console.log(JSON.stringify(zodToJsonSchema(schema), null, 2));
"
```

This will show exactly what JSON Schema is produced and whether it has `$schema`, `additionalProperties`, etc.

## 7. Test with Raw Anthropic API

Bypass the AI SDK entirely and test with a direct API call to isolate whether the issue is in the AI SDK adapter:

```bash
curl -X POST https://api.anthropic.com/v1/messages \
  -H "anthropic-version: 2023-06-01" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "claude-opus-4-20250514",
    "max_tokens": 1024,
    "tools": [
      {
        "name": "read_file",
        "description": "Read the contents of a file",
        "input_schema": {
          "type": "object",
          "properties": {
            "path": {"type": "string", "description": "Path to file"}
          },
          "required": ["path"]
        }
      }
    ],
    "messages": [
      {"role": "user", "content": "Read /etc/hostname"}
    ]
  }'
```

If this works but dispatch doesn't, the issue is in the AI SDK adapter or the schema conversion.
