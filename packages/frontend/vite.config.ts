import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
// Fallback only. ALWAYS prefer per-icon imports like:
//   import ListIcon from "phosphor-svelte/lib/ListIcon";
// Named imports from "phosphor-svelte" pull in the full barrel and slow Vite
// compilation. This plugin rewrites any stray named imports into per-icon
// default imports at build/dev time, so we don't get crippled if an agent
// forgets the correct pattern. Treat it as a safety net, not a license to
// use named imports.
import { sveltePhosphorOptimize } from "phosphor-svelte/vite";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [tailwindcss(), sveltePhosphorOptimize(), svelte()],
	server: {
		port: 5173,
		allowedHosts: true,
	},
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
