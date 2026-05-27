# Wishlist

- **Persist dashboard layout and chat history across sessions and devices.**
  - Restore any tabs that were left open when revisiting the page, including their order and active state.
  - If a chat was mid-generation (AI actively calling tools and streaming responses), automatically resume and continue from where it left off — even if the page was closed.
  - Chats continue processing server-side even when the frontend is entirely closed, meaning the AI keeps generating responses and calling tools without any browser open.
  - Start a chat on one device (e.g. desktop) and seamlessly pick it up later on another (e.g. phone).
  - Sidebar remembers which views were open and in what order, restoring them exactly as they were.

- **Edit chat history.** Click on any existing message in the chat history and choose to edit it — this applies to user messages, AI responses, and tool results.

- **AI can summon subagents using pre-configured agent types.** When the AI needs to delegate work, it can spawn subagents by selecting from a list of agent types that were defined in the agent editor page, rather than simply cloning itself with the same model.

- **Status indicator next to the chat input box.** A small icon sits to the left of the input area: a spinner while the AI is generating a response, a checkmark when it finishes successfully, and an X when the last generation errored out.
