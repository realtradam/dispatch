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

- **Fix the todo system.** The current task list tool and its UI have bugs or limitations that need addressing.


