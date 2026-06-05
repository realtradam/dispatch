import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Packages whose code imports Bun-only modules (e.g. `bun:sqlite`) can't run
		// under Vite's Node transform — they test via `bun test` (see `test:bun`).
		// Everything else runs here under vitest.
		projects: [
			"packages/*",
			"!packages/storage-sqlite",
			"!packages/trace-store",
			"!packages/observability-collector",
		],
	},
});
