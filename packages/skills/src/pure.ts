/**
 * Pure, zero-I/O functions for the skills extension.
 * All decision logic is input → output; no mocks needed for testing.
 */

/** A discovered skill entry (name + optional summary from metadata). */
export interface SkillEntry {
	readonly name: string;
	readonly summary?: string | undefined;
}

/** Result of parsing a skill file's metadata. */
export interface SkillMeta {
	readonly summary?: string | undefined;
	readonly hasMeta: boolean;
}

/**
 * Parse skill file metadata.
 * Line 1 = summary (when to use), Line 2 = "---" separator.
 * Returns `{ hasMeta: true, summary }` when line 2 is `---`.
 * Returns `{ hasMeta: false }` when line 2 is not `---` (malformed).
 */
export function parseSkillMeta(content: string): SkillMeta {
	const lines = content.split("\n");
	if (lines.length < 2) {
		return { hasMeta: false };
	}
	const line2 = lines[1];
	if (line2 === undefined || line2.trim() !== "---") {
		return { hasMeta: false };
	}
	const summary = lines[0];
	return { hasMeta: true, summary: summary?.trim() === "" ? undefined : summary };
}

/**
 * Strip the metadata header from a loaded skill body.
 * When hasMeta is true, returns lines 3+ (0-indexed: index 2 onward).
 * When hasMeta is false, returns the whole file unchanged.
 */
export function stripLoadedBody(content: string, hasMeta: boolean): string {
	if (!hasMeta) {
		return content;
	}
	const lines = content.split("\n");
	return lines.slice(2).join("\n");
}

/**
 * Merge home and cwd skill entries. Cwd skills shadow home skills of the same name.
 * Returns a deduplicated array sorted by name.
 */
export function mergeCatalog(
	homeEntries: readonly SkillEntry[],
	cwdEntries: readonly SkillEntry[],
): readonly SkillEntry[] {
	const map = new Map<string, SkillEntry>();
	for (const entry of homeEntries) {
		map.set(entry.name, entry);
	}
	for (const entry of cwdEntries) {
		map.set(entry.name, entry);
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Render the skill catalog into a description string for the tool definition.
 * Lists all skills by name; appends summary only for skills with valid metadata.
 */
export function renderDescription(catalog: readonly SkillEntry[]): string {
	if (catalog.length === 0) {
		return "Load a skill by name. No skills are currently available.";
	}
	const lines = ["Load a skill by name. Available skills:"];
	for (const entry of catalog) {
		if (entry.summary !== undefined) {
			lines.push(`- ${entry.name}: ${entry.summary}`);
		} else {
			lines.push(`- ${entry.name}`);
		}
	}
	return lines.join("\n");
}

/**
 * Validate that a skill name is a bare skill id (no path separators or traversal).
 * Returns true if the name is safe, false if it contains `/`, `\`, `..`, or is empty.
 */
export function isValidSkillName(name: unknown): name is string {
	if (typeof name !== "string" || name.length === 0) {
		return false;
	}
	if (name.includes("/") || name.includes("\\")) {
		return false;
	}
	if (name.includes("..")) {
		return false;
	}
	return true;
}

/**
 * Check that a resolved absolute path is within the base directory.
 * Prefix check — catches `..` traversal and absolute paths outside base.
 */
export function isPathWithinDir(resolvedPath: string, base: string): boolean {
	const normalizedBase = base.endsWith("/") ? base : `${base}/`;
	return resolvedPath === base || resolvedPath.startsWith(normalizedBase);
}
