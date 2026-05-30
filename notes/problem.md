# Problem: DeepSeek `reasoning_content` Dropped on Multi-Step Tool Calls

## Symptom

The first LLM call works (model makes a tool call). The second call fails with:

```
Error from provider (DeepSeek): The `reasoning_content` in the thinking mode must be passed back to the API.
```

This only happens when `maxSteps > 1` in `streamText` — i.e., when the agent loop calls the LLM a second time after executing a tool.

## Root Cause

A bug in `@ai-sdk/openai-compatible`. The package correctly **receives** `reasoning_content` from DeepSeek's response but silently **drops** it when building the next request.

### The chain of events:

1. **DeepSeek responds** with both `reasoning_content` (chain-of-thought) and `content` (answer) plus tool calls.

2. **`@ai-sdk/openai-compatible` parses the response** and correctly captures `reasoning_content` into the SDK's internal `reasoning` field.

3. **The AI SDK stores it** as a `{ type: "reasoning", text: "..." }` content part on the assistant message — this is correct.

4. **On the next step**, the SDK passes the message history back through `@ai-sdk/openai-compatible`'s `convertToOpenAICompatibleChatMessages()` to serialize it for the API. This function handles assistant message content parts with a switch statement:

   ```js
   // @ai-sdk/openai-compatible/dist/index.js, lines 90-120
   for (const part of content) {
     switch (part.type) {
       case "text": { /* handled */ break; }
       case "tool-call": { /* handled */ break; }
       // NO case "reasoning" — silently dropped!
     }
   }
   ```

5. **The outgoing request** has no `reasoning_content` field. DeepSeek requires it to be echoed back and rejects the request.

### Important: The agent code cannot fix this

The `streamText` function with `maxSteps` manages its own internal multi-step loop. The agent's `toCoreMessages()` is only called once for the initial prompt. The second call to DeepSeek is built entirely inside the SDK — the serialization bug is in `@ai-sdk/openai-compatible`, not in our code.

## Fix Options

### Option A: Patch `@ai-sdk/openai-compatible` (recommended)

Add a `case "reasoning"` branch to `convertToOpenAICompatibleChatMessages()` that writes `reasoning_content` back into the outgoing assistant message:

```js
case "reasoning": {
  reasoningContent = (reasoningContent ?? "") + part.text;
  break;
}
// Then in the push:
messages.push({
  role: "assistant",
  content: text,
  reasoning_content: reasoningContent ?? undefined,
  tool_calls: toolCalls.length > 0 ? toolCalls : void 0,
  ...metadata
});
```

Apply via `bun patch` or `patch-package`. File a bug/PR upstream against `@ai-sdk/openai-compatible`.

### Option B: AI middleware to strip reasoning

Use the AI SDK's `wrapLanguageModel` to intercept responses and remove `reasoning` parts before they enter the multi-step history. This avoids the error but loses the chain-of-thought content. Acceptable for Phase 1 since we don't display reasoning in the UI.

### Option C: Switch to a model without thinking mode

Use a DeepSeek model or configuration that doesn't enable thinking mode, if one is available through the OpenCode Zen endpoint. This avoids the problem entirely but limits model capability.

## Affected Files

- Bug location: `node_modules/@ai-sdk/openai-compatible/dist/index.js` (lines 90-120 in `convertToOpenAICompatibleChatMessages`)
- Our agent code: `packages/core/src/agent/agent.ts` — not the cause, cannot fix it from here
- Upstream repo: https://github.com/vercel/ai (the `@ai-sdk/openai-compatible` package)
