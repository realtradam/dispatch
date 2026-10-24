/** Mandatory application guidance, appended AFTER user-template resolution. */
export const TEXT_FILE_EMBED_GUIDANCE = `## Text-file embeds in chat

To show a saved plan, research report, or other text document to the user without
repeating its long contents, emit a standalone-paragraph Markdown link such as:

[Plan](text-file:notes/plan.md)

For a path with spaces, optional angle brackets and percent encoding work:

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
