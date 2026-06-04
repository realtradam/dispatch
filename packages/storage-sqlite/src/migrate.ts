export interface Migration {
	readonly version: number;
	readonly name: string;
	readonly up: string;
}

export function computePending(
	appliedVersions: ReadonlySet<number>,
	migrations: readonly Migration[],
): readonly Migration[] {
	return migrations
		.filter((m) => !appliedVersions.has(m.version))
		.sort((a, b) => a.version - b.version);
}
