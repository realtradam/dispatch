/**
 * Language ID mapping from file extensions.
 */

const extensionMap: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".lua": "lua",
	".luau": "luau",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".md": "markdown",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".css": "css",
	".html": "html",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
};

export function languageId(filePath: string): string {
	const dotIdx = filePath.lastIndexOf(".");
	if (dotIdx === -1) return "unknown";
	const ext = filePath.slice(dotIdx).toLowerCase();
	return extensionMap[ext] ?? "unknown";
}
