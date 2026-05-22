import * as path from "node:path";
import { parse } from "smol-toml";
import type { SkillDefinition, SkillDirectory, SkillScope } from "../types/index.js";

const FRONTMATTER_DELIMITER = "+++";

export function parseSkillFile(
	filePath: string,
	content: string,
	scope: SkillScope,
	directory: SkillDirectory,
): SkillDefinition {
	const defaultName = path.basename(filePath, path.extname(filePath));

	let name = defaultName;
	let description = "";
	let tags: string[] = [];
	let body = content;

	// Check for TOML frontmatter
	const trimmed = content.trimStart();
	if (trimmed.startsWith(FRONTMATTER_DELIMITER)) {
		const afterOpen = trimmed.slice(FRONTMATTER_DELIMITER.length);
		// Find the closing +++
		const closeIndex = afterOpen.indexOf(FRONTMATTER_DELIMITER);
		if (closeIndex !== -1) {
			const tomlSource = afterOpen.slice(0, closeIndex);
			body = afterOpen.slice(closeIndex + FRONTMATTER_DELIMITER.length);

			try {
				const frontmatter = parse(tomlSource);

				if (typeof frontmatter["name"] === "string") {
					name = frontmatter["name"];
				}
				if (typeof frontmatter["description"] === "string") {
					description = frontmatter["description"];
				}
				if (Array.isArray(frontmatter["tags"])) {
					tags = (frontmatter["tags"] as unknown[]).filter(
						(t): t is string => typeof t === "string",
					);
				}
			} catch {
				// Malformed TOML — fall through with defaults
			}
		}
	}

	// Trim leading newline from body (handles both LF and CRLF)
	body = body.replace(/^\r?\n/, "");

	return {
		name,
		description,
		tags,
		content: body,
		scope,
		source: filePath,
		directory,
	};
}
