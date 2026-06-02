# Wishlist

## Session Persistence & Cross-Device Continuity

- `[partial]` **Resume mid-generation after page close.** If a chat was mid-generation (AI actively calling tools and streaming responses), automatically resume and continue from where it left off — even if the page was closed. *(Currently catches up via TabStatusSnapshot over WebSocket, but in-flight chunks are in-memory only and lost on server restart.)*

- `[pending]` **Auto-close subtabs when parent tab is closed.** When the user closes a tab, automatically close all its subtabs first (cancelling any in-progress generation), then close the parent tab.

- `[pending]` **Tab forking.** Allow the user to go to any message in a tab and click "fork" to create a new tab that branches the conversation from just before that message. The forked tab must correctly inherit and continue the caching context so that cache hits are preserved across the fork. Additionally, support agent-initiated forking: agents (both user agents and subagents) can fork a tab by receiving a message along with a tab ID, causing the system to fork from that point instead of starting fresh. The system should automatically resolve the correct agent, model, key, and tool set for the forked tab based on the source tab's configuration.

## Tool Call & Output Display

- `[partial]` **Update the way tools appear in the chat UI.** Improve the visual presentation of tool calls and their results — make them more readable, compact, and scannable. *(Collapsible blocks with status badges exist, but args/results are raw JSON in `<pre>` tags with no tool-type-specific visualizations.)*

- `[pending]` **Show git diffs for edited files.** When the AI edits a file (write_file tool call), display a git diff in the UI rather than just the raw file content.

- `[partial]` **Show live shell output in a collapsible block.** When a shell command is running, show live stdout/stderr in a collapsible shell block (similar to the thinking block), instead of requiring the user to expand the tool call and read raw JSON. *(Backend streams shell-output events in real-time and frontend shows them, but inside the tool call collapse — not a separate auto-expanding/auto-scrolling block.)*

## Context & Token Management

- `[partial]` **Track token usage in a tab.** Display token usage (e.g. prompt/completion/total tokens) for the chat within each tab. Also track and display cache hit rate alongside it. Cache hit rate data should be loaded in the frontend on every turn regardless of whether the CacheRatePanel sidebar view is open, so it's always available at a glance. *(Backend emits usage events and a CacheRatePanel sidebar view exists, but nothing in the tab bar or chat panel itself, and stats are only populated when the panel is mounted.)*

- `[pending]` **Compaction tool.** A tool to compact/summarize the conversation history to reduce context size while preserving important information.

## UI / UX Polish & Reorganization

- `[pending]` **Per-model/key effort level setting in agents page.** Allow setting the effort level (e.g. low, medium, high) for each model/key set directly in the agents configuration page. Display the configured effort level in the agents view so it is visible at a glance alongside the model and key info.

- `[pending]` **Per-tab chat input state.** Each tab should have its own chat input box. When switching tabs, the unsent text in the current tab should be saved and the text for the newly selected tab should be restored — so draft messages are never lost or clobbered by tab switching.

- `[pending]` **Image attachments for supported models.** Allow attaching and uploading images in the chat input for models that support vision/multimodal input. Before sending, check (e.g. via a capabilities ping or metadata lookup) whether the current model supports image input — if it does not, show a clear message instead of silently failing.

- `[pending]` **Better tab controls.** Add tab drag-and-drop to reorder tabs and double-click tab title to rename (click away or press Enter to confirm the new name).

### Layout & Positioning

- `[pending]` **Make the plus button on tabs always on top and to the left.** The "+" button for creating new tabs is currently mixed in with the scrollable tab list. It should be fixed/absolute positioned at the top-left of the tab bar so it's always visible regardless of horizontal scrolling.

- `[pending]` **Add a status bar under the chatbox with the send button.** Move the send button into a status bar that sits below the chat input/textarea. The status bar could show generation status, token counts, etc. Also consider whether we even need a send button at all — pressing Enter already sends the message, so the button may be redundant.

## PWA

- `[pending]` **PWA support with cache busting.** Add Progressive Web App support with a proper cache busting solution. The frontend should have a static `version.json` file that can be fetched at any time to check whether the current PWA version is out of date. Cache the current PWA version locally so we can compare against the remote `version.json` and know exactly when to unregister the service worker and reload the new version.

## New Tools

- `[pending]` **Implement a search code tool utilizing [cs](https://github.com/boyter/cs).** Add a dedicated tool that lets the agent search through the codebase using [cs](https://github.com/boyter/cs) — a fast code search utility. This would provide more efficient and targeted code search than relying on generic shell commands like `grep` or `find`.

- `[pending]` **Key usage levels tool.** Add a tool that lets the agent read the current usage levels of API keys — including request counts, token consumption, rate limit proximity, and any other relevant metrics. This would allow the agent to make informed decisions about key selection, proactively warn about approaching limits, and help troubleshoot when requests start failing due to exhausted keys.

## Reliability & Bug Fixes

- `[partial]` **Fix the todo system.** The current task list tool and its UI have bugs or limitations that need addressing. *(The TaskList class and todo tool work with clean validation, but there's no dedicated frontend UI panel for todos beyond sidebar references.)*

- `[partial]` **Fix the Claude reset system.** The "Claude Wake Schedule" panel (ClaudeReset.svelte) allows scheduling model wake/reset times. There are bugs or limitations in the current implementation that need fixing — get it working reliably. *(Major improvements made — SnapshotSequencer, global mutation lock, 4-probe coalescing, boot recovery — but server-side request reordering can still desync UI, and toggle endpoint ignores client intent.)*

- **Fix key switching not migrating context correctly.** When switching API keys (e.g. hitting usage limits on one key and switching to another), the new agent appears to receive only the initial system prompt — all subsequent thinking, tool calls, and conversation history are lost. The full chat context including all turns needs to be properly passed to the new key/model so the conversation continues seamlessly.

- `[pending]` **Fix Mimo incorrect thinking levels.** Mimo doesn't have a "max" thinking level — the current hardcoded options are wrong. Explore dynamically obtaining the available thinking levels from the provider (e.g. via API metadata or model capabilities) rather than relying on static assumptions.

- `[pending]` **Fix AI automatic tab naming.** The AI-powered automatic tab naming feature doesn't appear to be doing anything — tabs aren't being automatically renamed based on conversation content. Investigate and fix so that tabs get meaningful auto-generated names.

- `[pending]` **Fix Chat Settings vs agent setting conflict.** Manual settings in the Chat Settings panel don't properly take effect — the agent-level setting is secretly overriding them, creating a confusing conflict where the user's explicit settings are silently ignored.

- `[pending]` **Fix agent tools leaking across tabs.** Changing an agent in one tab causes its tools to persist globally across all tabs — switching tabs doesn't restore the correct per-tab tools. Tools should be loaded and persisted per-tab from the backend, not stored in shared frontend state. Investigate to determine the best solution for per-tab tool isolation.

- `[pending]` **Fix agent and manual model setting changing on tab switch.** When switching tabs, the current agent selection and manual model override appear to change unexpectedly — possibly due to state leaking between tabs similar to the tools issue above. Investigate alongside the tools isolation fix.

- `[pending]` **Backgrounding is too aggressive.** Agents sometimes background shell calls or subagents unnecessarily and then invoke shell calls with `sleep` to wait for them to finish. If the agent is just going to wait for results anyway, it should not background the calls in the first place — avoid the wasteful pattern of backgrounding then sleeping to await completion.

## Minor Fixes

- `[pending]` **Cache rate view requests bubble text wrapping.** The requests count bubble (e.g. "36 req") in the Cache Rate panel wraps when it shouldn't — should stay on one line with `whitespace-nowrap`.

- `[pending]` **Remove cache cost explanation from Cache Rate panel.** Remove the "Cache reads cost ~10% of fresh input; writes cost ~25% more..." paragraph from CacheRatePanel.svelte.

- `[pending]` **Key usage bar coloring.** In the key usage view, bar color should be: green if less than the time dot, orange if to the right of the time dot, red if greater than 90% in any case.