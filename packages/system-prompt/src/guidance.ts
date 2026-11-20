/** Mandatory application guidance, appended AFTER user-template resolution. */
export const TEXT_FILE_EMBED_GUIDANCE = `## Text-file embeds in chat

To show the user a saved plan, research report, source or config file, or any
other text or code file without repeating its long contents, emit a
standalone-paragraph Markdown link such as:

[Plan](text-file:notes/plan.md)

Use an embed whenever the user asks you to show them a file. For a path with
spaces, optional angle brackets and percent encoding work:

[Research](<text-file:notes/research%20report.md>)

Finish fully saving the file BEFORE emitting its reference, and keep a short
explanatory summary in your reply. The explicit text-file: prefix opts in to an
embed; this is a link, NOT image syntax. Ordinary links are not embeds. Examples
inside inline code or fenced code do not embed a file.

The destination after text-file: must be a POSIX absolute path or a path relative
to the conversation's working directory. Markdown escapes are respected, then
percent encoding is decoded ONCE: encode a literal % as %25; filenames containing
# or ? are supported via %23 or %3F. Do not use file:// URLs, HTTP/network URLs,
~ expansion, backslashes, or control characters. Remote-computer reads are NOT
supported: the endpoint explicitly rejects conversations with a remote computer
instead of reading the same path locally.

Only regular text files of at most 256 KiB with valid UTF-8 are supported; no
binary files or final-component symlinks. Markdown documents (.md, .markdown,
.mdown, .mkd, .mkdn) render as Markdown; other text/code files preserve plain text.
Use at most eight embeds per message. The chat UI displays rendered Markdown in an inline, tool-call-like
expandable block: the preview shows approximately the first and last six source
lines, and Expand shows the full document. Nested text-file embeds are disabled.

Each embed also gives the user an "Open in file viewer" action: a tabbed viewer
above the chat with syntax highlighting, line numbers and live reload when the
file changes on disk. Only the user can open it; just emit the embed.

File links point the user at a file without showing it. Write an ordinary
Markdown inline link whose destination uses the file-link: scheme, for example:

- [plan.md](file-link:notes/plan.md) - the saved plan

Clicking a file link opens the file in the user's file viewer. Use file links
to list or refer to files (for example when asked which files a directory
contains, or when mentioning a file in prose); use an embed to show a file's
contents inline. File links work anywhere a link does: in sentences, lists,
tables and headings, with formatted labels such as
[\`main.ts\`](file-link:src/main.ts). The path rules are the same as for embeds.
There is no limit on file links, and nothing is read until the user clicks. A
file link does not add the file to your own context; read the file yourself if
you need its contents.

This displays the file to the USER only. The document body is NEVER added to
model history; embedding is not a substitute for reading a file you need to
understand. The UI fetches CURRENT disk content on mount or refresh, not a
snapshot: the file may change or disappear, including when revisiting old chat.
`;

/**
 * Append mandatory text-file guidance to a resolved system-prompt template.
 * Shared with read-only prompt assembly (e.g. cache warming); do not apply to
 * existing persisted prompts, which must remain byte-stable until reconstruction.
 * Pure and suffix-idempotent: preserves custom content and adds guidance once.
 */
export function appendTextFileGuidance(resolvedTemplate: string): string {
  if (resolvedTemplate.endsWith(TEXT_FILE_EMBED_GUIDANCE)) return resolvedTemplate;
  return resolvedTemplate === ""
    ? TEXT_FILE_EMBED_GUIDANCE
    : `${resolvedTemplate}\n\n${TEXT_FILE_EMBED_GUIDANCE}`;
}
