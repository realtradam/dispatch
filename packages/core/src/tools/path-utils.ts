import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve a path to its canonical absolute form, following symlinks at
 * every level.
 *
 * When the leaf does not exist (common for `write_file` creating a new
 * file), walks up to the nearest existing ancestor, canonicalizes that,
 * then re-appends the missing trailing segments — ensuring a symlink in
 * the *middle* of the path is still resolved. Without this, a
 * `workdir/escape-link/new-file.txt` write where `escape-link` points
 * outside the workdir would slip the containment check.
 *
 * Used everywhere we compare a user-supplied path against a trusted
 * root (workdir, SPILL_ROOT). Resolving symlinks consistently is the
 * only reliable way to detect a symlink-in-workdir-pointing-outside
 * escape; lexical-only checks let those through.
 *
 * Argument semantics match `path.resolve(...paths)`: later absolute
 * segments override earlier ones, relative segments are joined.
 */
export async function canonicalize(...paths: string[]): Promise<string> {
	const lexical = resolve(...paths);

	// Fast path: full path exists, realpath resolves all symlinks.
	try {
		return await realpath(lexical);
	} catch {
		// Path doesn't exist — fall through to ancestor walk.
	}

	// Walk up until we hit an existing ancestor we can realpath, then
	// re-append the missing trailing segments. This handles cases like
	// write_file creating /workdir/symlink/new/dir/file.txt where the
	// "symlink" segment exists but the rest doesn't.
	let current = lexical;
	const trailing: string[] = [];
	while (true) {
		const parent = dirname(current);
		if (parent === current) break; // hit filesystem root
		trailing.unshift(basename(current));
		try {
			const realParent = await realpath(parent);
			return join(realParent, ...trailing);
		} catch {
			current = parent;
		}
	}

	// No existing ancestor (pathological — e.g. the entire mount is gone).
	// Return the lexical path; downstream containment checks will still
	// catch obvious escapes via `..` etc.
	return lexical;
}
