# Schema Debug — What zodToJsonSchema Actually Produces

Run this to see what the AI SDK actually sends to Anthropic:

```bash
node --experimental-strip-types -e "
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const schema = z.object({
    path: z.string().describe('Path to the file, relative to the working directory'),
    offset: z.number().int().min(1).optional().describe('1-indexed start line. Default: 1.'),
    limit: z.number().int().min(1).optional().describe('Max lines to return. Default: 500. Hard cap: 5000.'),
});

console.log(JSON.stringify(zodToJsonSchema(schema), null, 2));
"
```

## Check the @ai-sdk/anthropic adapter's tool serialization

```bash
grep -n 'input_schema\|tools\|jsonSchema\|convertTools' node_modules/@ai-sdk/anthropic/dist/index.mjs | head -30
```

## Check if streamText is receiving the tools correctly

Look at how streamText processes tool options in the AI SDK:

```bash
grep -n 'tools\|toolChoice\|toolCall' node_modules/ai/dist/index.mjs | head -40
```

## Key questions to answer

1. Does `zodToJsonSchema` output `$schema`? If yes, Anthropic may silently reject the tool definition.
2. Does it output `additionalProperties`? Same concern.
3. Does the `@ai-sdk/anthropic` adapter strip these before sending to the API?
4. Does the adapter forward parameter `description` fields from JSON Schema to Anthropic's wire format?
5. Is `tool_choice` being set or defaulting to something suboptimal?
