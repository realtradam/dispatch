# Anthropic Tool Format — What Claude Actually Expects

## The Correct Anthropic API Tool Format

```json
{
  "tools": [
    {
      "name": "tool_name",
      "description": "What this tool does",
      "input_schema": {
        "type": "object",
        "properties": {
          "param1": {
            "type": "string",
            "description": "What param1 is"
          }
        },
        "required": ["param1"]
      }
    }
  ],
  "tool_choice": { "type": "auto" }
}
```

### Key requirements

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | **Yes** | Must match `^[a-zA-Z0-9_-]{1,64}$` |
| `description` | string | Strongly recommended | Claude uses this to decide when to call |
| `input_schema` | object | **Yes** | JSON Schema; root must have `type: "object"` |
| `input_schema.type` | string | **Yes** | MUST be `"object"` |
| `input_schema.properties` | object | Recommended | Each property needs `type` and `description` |
| `input_schema.required` | string[] | Optional | Lists required property names |

### Anthropic does NOT support in input_schema

1. **`$schema`** — JSON Schema meta-keyword; Anthropic rejects it
2. **`additionalProperties`** — Not supported; can cause silent schema rejection
3. **`default`** — Not part of Anthropic's JSON Schema subset
4. **`type` as array** (e.g. `["string", "null"]`) — Rejected
5. **`type: "null"`** — Rejected  
6. **`nullable`** keyword — Not supported
7. **`anyOf` / `oneOf` / `allOf`** — Not supported (combiners)
8. **`$ref` / `$defs` / `$dynamicRef`** — Not supported
9. **`propertyNames`** — Not supported

## What Claude Code (the CLI) Uses Internally

Claude Code has its OWN internal tool definitions. They use a specific format that Claude has been trained on extensively. When you use Claude outside of Claude Code, the model loses:

1. **The exact tool descriptions** it was trained on in Claude Code
2. **The precise schema format** Claude Code uses
3. **The system prompt** that tells Claude to use tools proactively
4. **The billing/identity headers** that tell Anthropic this is a "real" CLI session

### The billing header trick

From `packages/core/src/credentials/claude.ts`:

```
x-anthropic-billing-header: cc_version=2.1.112.xxx; cc_entrypoint=sdk-cli; cch=xxxxx;
```

And the identity preamble:
```
"You are Claude Code, Anthropic's official CLI for Claude."
```

These are mirrored from opencode, but **they go beyond what the raw API needs**. They're hacks to get Anthropic's backend to treat the request as coming from Claude Code.

## Why Claude Opus "Thinks Forever"

Common causes when tools don't get called:

1. **Tool schema has unsupported fields** → Anthropic silently ignores the tool → Claude never sees it → Claude just talks
2. **Missing description on parameters** → Claude doesn't know what values to provide → stalls
3. **`input_schema` missing `type: "object"`** → Anthropic rejects the tool entirely
4. **`tool_choice` is wrong** → Set to `"none"` or Claude decides not to use tools
5. **System prompt doesn't instruct tool use** → Claude doesn't realize it should call tools
6. **Anthropic beta headers missing** → Extended thinking or new features might not work
7. **Thinking budget too high** → Claude uses all tokens thinking and never gets to tool calls

## Sources

- https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- https://docs.aimlapi.com/capabilities/anthropic
- https://sdk.vercel.ai/providers/ai-sdk-providers/anthropic
