# Wishlist

- **Persist dashboard layout and chat history across sessions and devices.**
  - Restore any tabs that were left open when revisiting the page, including their order and active state.
  - If a chat was mid-generation (AI actively calling tools and streaming responses), automatically resume and continue from where it left off — even if the page was closed.
  - Chats continue processing server-side even when the frontend is entirely closed, meaning the AI keeps generating responses and calling tools without any browser open.
  - Start a chat on one device (e.g. desktop) and seamlessly pick it up later on another (e.g. phone).
  - Sidebar remembers which views were open and in what order, restoring them exactly as they were.

- **Edit chat history.** Click on any existing message in the chat history and choose to edit it — this applies to user messages, AI responses, and tool results.

- **Status indicator next to the chat input box.** Exists: spinner while running, checkmark on success, X on error. Needs: clickable to cancel (with text label), not just the spinner icon.

- **Update the way tools appear in the chat UI.** Improve the visual presentation of tool calls and their results — make them more readable, compact, and scannable.

- **Show git diffs for edited files.** When the AI edits a file (write_file tool call), display a git diff in the UI rather than just the raw file content.

- **Show live shell output in a collapsible block.** When a shell command is running, show live stdout/stderr in a collapsible shell block (similar to the thinking block), instead of requiring the user to expand the tool call and read raw JSON.

- **ntfy push notifications.** Configurable ntfy.sh notifications — ping on chat completion, errors, permission prompts, and other events. Configure topic URL and which events trigger notifications.

- **Failed tool calls should produce proper tool results, not get silently dropped.**
  - Repro: agent calls `read_file` but the tool is unavailable → SDK emits `tried to call unavailable tool`. User grants permission and asks agent to retry. Agent tries again, but the SDK now errors with `Tool results are missing for tool calls call_00_..., call_01_...` — the previous step's tool calls were recorded (IDs registered in the assistant message) but their results were never written (because the stream aborted when the unavailable-tool error was caught). The synthetic error path in agent.ts (lines 856-882) only covers the ONE tool that triggered the error; sibling tool calls in the same batch that the LLM sent alongside the unavailable one have their IDs in the history but no matching tool-result, which trips the v6 SDK validation.
  - Fix: when the unavailable-tool error is caught, every tool call in `stepToolCalls` that doesn't already have a result should receive a synthetic tool-result explaining the failure (e.g. "This step was aborted because tool X is unavailable."). The existing per-tool synthetic result only covers the offending tool; the rest of the batch becomes orphaned.
  - Beyond the unavailable-tool case more generally: any path that yields tool-call events without a matching tool-result leaves the history in an un-roundtrippable state. Consider adding a `failed` or `aborted` state to tool results so the model can distinguish "the tool ran and returned this output" from "the tool never ran because something went wrong upstream."
