/**
 * File-extension → LSP `languageId` map.
 *
 * The LSP `textDocument/didOpen` notification carries a `languageId` string
 * that tells the server how to parse the document. This table is a trimmed
 * port of opencode's `lsp/language.ts`, with one critical addition for this
 * project: `.luau` → `"luau"`. Roblox Luau sources use the `.luau` extension,
 * which standard Lua tooling does not recognise — luau-lsp expects the
 * `"luau"` languageId.
 *
 * Extensions are looked up with their leading dot (e.g. `".luau"`). Unknown
 * extensions fall back to `"plaintext"` at the call site.
 */
export const LANGUAGE_EXTENSIONS: Record<string, string> = {
	// Luau (Roblox) — the reason this module exists. Keep first for visibility.
	".luau": "luau",
	".lua": "lua",
	// A pragmatic subset of common languages, mirroring opencode's table so a
	// user can point an arbitrary LSP server at this codebase and have the
	// right languageId reported.
	".c": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".h": "c",
	".hpp": "cpp",
	".cs": "csharp",
	".css": "css",
	".dart": "dart",
	".go": "go",
	".html": "html",
	".htm": "html",
	".java": "java",
	".js": "javascript",
	".jsx": "javascriptreact",
	".json": "json",
	".jsonc": "jsonc",
	".kt": "kotlin",
	".kts": "kotlin",
	".md": "markdown",
	".markdown": "markdown",
	".php": "php",
	".py": "python",
	".rb": "ruby",
	".rs": "rust",
	".scss": "scss",
	".sass": "sass",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".sql": "sql",
	".svelte": "svelte",
	".swift": "swift",
	".toml": "toml",
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".vue": "vue",
	".xml": "xml",
	".yaml": "yaml",
	".yml": "yaml",
	".zig": "zig",
};

/**
 * Resolve the LSP `languageId` for a file path's extension, falling back to
 * `"plaintext"` when the extension is unknown.
 */
export function languageIdForExtension(extension: string): string {
	return LANGUAGE_EXTENSIONS[extension] ?? "plaintext";
}
