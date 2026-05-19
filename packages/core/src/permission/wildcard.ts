export const Wildcard = {
	match(pattern: string, value: string): boolean {
		// Escape regex special chars except * and ?
		const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		// Convert wildcards
		const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
		const regex = new RegExp(`^${regexStr}$`, "s");
		return regex.test(value);
	},
};
