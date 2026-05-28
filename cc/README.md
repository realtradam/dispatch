# Claude Opus Tool Calling Investigation

## Problem
Claude Opus "thinks forever" and doesn't call tools when used outside Claude Code's harness (in Dispatch's own agent harness).

## Summary of Findings

### 1. Tool Schema Format
Dispatch uses the AI SDK v6 (`@ai-sdk/anthropic@^3.x`) which should handle format conversion automatically. However, `zodToJsonSchema()` produces Draft 7 JSON Schema with fields (`$schema`, `additionalProperties`, `default`) that Anthropic's API doesn't support. Dispatch does **no schema normalization**.

### 2. Anthropic's requirements
Anthropic's `input_schema` must be clean JSON Schema:
- Root `type: "object"` is mandatory
- No `$schema`, `additionalProperties`, `default`, `nullable`
- No combiners (`anyOf`, `oneOf`, etc.)
- Parameter `description` fields are strongly recommended

### 3. Missing tool_choice
Dispatch doesn't set `tool_choice` in `streamText()` options. The default may cause Opus to not call tools.

### 4. System prompt
The system prompt tells Opus what tools exist but may not be forceful enough about actually USING them instead of just talking about solutions.

### 5. No Anthropic-specific schema normalization
Unlike opencode's `normalizeSchemaForCCA()`, dispatch passes raw JSON Schema to the AI SDK without stripping unsupported fields.

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/tools/registry.ts` | Tool → AI SDK conversion |
| `packages/core/src/agent/agent.ts` | Agent loop, `streamText({tools})` |
| `packages/api/src/agent-manager.ts` | Provides tool config to agent |
| `packages/core/src/llm/provider.ts` | Provider creation |

## Next Steps

See `03-recommendations.md` for specific fixes to try.
