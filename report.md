# Code Review — DeepSeek `reasoning_content` fix

## Verdict
**Ship-with-followups.** The removal of the v4-era middleware correctly resolves the primary bug: `reasoning_content` is now passed to the AI SDK as `{ type: "reasoning" }` parts, which the v6 SDK successfully serializes to the wire format instead of burying it in a dead `providerMetadata` key. However, the fix strictly relies on the AI SDK's native serialization, which introduces a critical edge case for empty reasoning blocks that the reference OpenCode implementation explicitly handles.

## Bugs found (must-fix)
*(None blocking the immediate happy-path fix, but see edge cases below)*

## Edge cases / risks
*   **The Empty-Reasoning Edge Case:** DeepSeek (and other models) can occasionally emit an empty reasoning block. In Dispatch, `toModelMessages` will correctly emit `{ type: "reasoning", text: "" }`. However, `@ai-sdk/openai-compatible@2.0.48` strips `reasoning_content` entirely if the text is empty:
    ```javascript
    // node_modules/@ai-sdk/openai-compatible/dist/index.mjs:245
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ```
    If DeepSeek emitted an empty reasoning block in a previous turn, the SDK will drop `reasoning_content` from the subsequent request payload. DeepSeek requires this field to be present (even if empty) during a thinking-mode session and will crash with the exact same "must be passed back" error.

## opencode reference parity gaps
*   **Forced empty string serialization:** The OpenCode reference implementation specifically works around the SDK's empty-string stripping behavior in `packages/opencode/src/provider/transform.ts:233-241`:
    ```typescript
    // Always set the field even when empty — some providers (e.g. DeepSeek) may return empty
    // reasoning_content which still needs to be sent back in subsequent requests.
    ```
    It enforces this by stripping the `reasoning` parts and injecting the `providerOptions.openaiCompatible[field]` directly. Dispatch's fix misses this workaround because it relies 100% on the AI SDK's native serialization.

## Test coverage gaps
*   **Empty Reasoning Handling:** The new `agent.test.ts` integration test ("openai-compatible reasoning round-trip...") only tests the happy path with non-empty reasoning (`text: "let me reason about this"`). It should include a test asserting that `text: ""` still results in a valid request (which currently would fail against the wire, though testing this fully might require mocking the provider wire payload rather than just `streamText` arguments).
*   **Tool calls + Reasoning:** There is no test verifying that an assistant message with both reasoning and a tool call correctly passes both to `streamText` for the `openai-compatible` provider (though the logic in `toModelMessages` handles it).
*   **Multiple reasoning blocks:** The AI SDK concatenates multiple reasoning parts natively, but an integration test verifying that Dispatch's `toModelMessages` correctly emits all of them would be valuable.

## Style / consistency
*   **Clean removal:** The deletion of the obsolete middleware and the cleanup of `packages/core/src/llm/provider.ts` is idiomatic and cleanly delegates responsibility to the v6 AI SDK.
*   **Comments:** The new block comment in `provider.ts` accurately explains why the old middleware broke DeepSeek and why the SDK handles it natively now.

## Other observations
*   **Redacted Reasoning:** The removed middleware stripped `redacted-reasoning` types. This is no longer necessary because Dispatch's `toModelMessages` only knows how to emit `text`, `reasoning`, and `tool-call` parts; it intrinsically filters out any other internal chunk types. This means no regressions are introduced regarding redacted reasoning.
*   **Empty part filtering for Anthropic:** The `applyAnthropicStructuralNormalisations` function correctly strips empty reasoning/text parts, but this is safely gated behind `usesAnthropicSDK`, so it will not interfere with DeepSeek's `openai-compatible` path.