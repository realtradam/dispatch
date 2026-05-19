import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		server: {
			deps: {
				// Force inline resolution for packages that break under Bun's
				// .bun/ symlink layout in Docker environments
				inline: ["zod"],
			},
		},
	},
});
