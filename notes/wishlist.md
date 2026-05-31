# Wishlist

- **Persist dashboard layout and chat history across sessions and devices.**
  - Restore any tabs that were left open when revisiting the page, including their order and active state.
  - If a chat was mid-generation (AI actively calling tools and streaming responses), automatically resume and continue from where it left off — even if the page was closed.
  - Chats continue processing server-side even when the frontend is entirely closed, meaning the AI keeps generating responses and calling tools without any browser open.
  - Start a chat on one device (e.g. desktop) and seamlessly pick it up later on another (e.g. phone).
  - Sidebar remembers which views were open and in what order, restoring them exactly as they were.

- **Update the way tools appear in the chat UI.** Improve the visual presentation of tool calls and their results — make them more readable, compact, and scannable.

- **Show git diffs for edited files.** When the AI edits a file (write_file tool call), display a git diff in the UI rather than just the raw file content.

- **Show live shell output in a collapsible block.** When a shell command is running, show live stdout/stderr in a collapsible shell block (similar to the thinking block), instead of requiring the user to expand the tool call and read raw JSON.

- **ntfy push notifications.** Configurable ntfy.sh notifications — ping on chat completion, errors, permission prompts, and other events. Configure topic URL and which events trigger notifications.

- **Fix the todo system.** The current task list tool and its UI have bugs or limitations that need addressing.

- **Track token usage in a tab.** Display token usage (e.g. prompt/completion/total tokens) for the chat within each tab.

- **Fix queue not being consumed after the AI finishes its turn.** When the AI completes its turn, a queued user message is just attached to the chat without continuing the conversation — the turn ends instead of consuming the queue and generating a response. The queued message should kick off a new turn.

- **Compaction tool.** A tool to compact/summarize the conversation history to reduce context size while preserving important information.

- **Make the plus button on tabs always on top and to the left.** The "+" button for creating new tabs is currently mixed in with the scrollable tab list. It should be fixed/absolute positioned at the top-left of the tab bar so it's always visible regardless of horizontal scrolling.

- **Add a status bar under the chatbox with the send button.** Move the send button into a status bar that sits below the chat input/textarea. The status bar could show generation status, token counts, etc. Also consider whether we even need a send button at all — pressing Enter already sends the message, so the button may be redundant.

- **Move the copy button into a new "Debug" sidebar view.** The "Copy" button in the header copies the full conversation to clipboard. Move it into a new "Debug" sidebar panel/View that groups dev-facing actions.

- **Move the theme picker into the Settings panel.** The "Theme" button in the header currently opens a modal ThemeSwitcher. Move theme selection into the existing "Settings" sidebar panel so there's one place for all settings, decluttering the header.

- **Update the sidebar button to a hamburger icon.** The sidebar toggle button currently just says "Sidebar" text. Replace it with a proper hamburger/three-line icon (☰) for a cleaner, more standard UI.

- **Adopt Phosphor icons.** Start using the Phosphor icon set throughout the UI to replace text labels and ad-hoc SVG icons with a consistent, high-quality icon library.

- **Fix the Claude reset system.** The "Claude Wake Schedule" panel (ClaudeReset.svelte) allows scheduling model wake/reset times. There are bugs or limitations in the current implementation that need fixing — get it working reliably.

- **Tab-to-tab agent communication via visible IDs.** Each tab gets a short, human-readable unique ID visible somewhere in the UI (e.g. in the tab bar or a sidebar view). Agents get a tool that lets them send a user message to another agent by its tab ID, and another tool to retrieve the last turn's response from that tab. When an agent sends a message this way:
  - If the target agent is mid-turn, the message is queued (same as a user message).
  - If the target agent is idle, the message wakes it up and starts a new turn.
  This enables workflows like giving an agent a tab ID and asking it to steer another AI, chain agents together, or have one agent delegate subtasks to another.

- **"User agents" — summon counterpart to subagents.** Currently agents can summon subagents which are owned by a parent tab (they appear indented under the parent in the tab bar). Add a "user agent" summon variant that spawns a standard top-level tab owned by the user rather than by another tab. This gives agents the ability to open new independent tabs (like a user would), enabling more complex multi-agent workflows where spawned agents persist as first-class tabs.

- **Fix key switching not migrating context correctly.** When switching API keys (e.g. hitting usage limits on one key and switching to another), the new agent appears to receive only the initial system prompt — all subsequent thinking, tool calls, and conversation history are lost. The full chat context including all turns needs to be properly passed to the new key/model so the conversation continues seamlessly.

- **Worktree workflow skill.** A skill for orchestration agents that enables executing several plans or feature implementations in parallel using git worktrees. Each worktree gets its own isolated checkout of the repo at a given branch/commit, so multiple agents can work independently on different features without stepping on each other. The orchestration agent manages creating worktrees, assigning tasks to sub-agents per worktree, reviewing results, and merging back.
