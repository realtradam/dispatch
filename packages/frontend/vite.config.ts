import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [tailwindcss(), svelte()],
	server: {
		port: 5173,
		allowedHosts: true,
	},
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
