// plugin-scaffold — the frontend module's build config (plan 03).
//
// THE SPIKE'S EXACT EXTERNALIZATION CONFIG, canned: ONE standalone ESM file
// with the whole `svelte` package externalized (bare specifiers in the
// output). The HOST's import map resolves those bare specifiers to the
// app's own Svelte 5 runtime — one shared runtime; bundling svelte here
// would create a SECOND runtime and break cross-component reactivity.
//
// `discloseVersion: false` drops the dev-only `svelte/internal/disclose-version`
// import svelte 5.56 otherwise emits even in production compiles.
//
// Output: `frontend.js` at the package root (the manifest's
// `frontend.entry`, served at `GET /plugins/plugin-scaffold/frontend`).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const pkgRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte({ compilerOptions: { discloseVersion: false } })],
  build: {
    outDir: pkgRoot,
    emptyOutDir: false,
    lib: {
      entry: resolve(pkgRoot, "src/frontend.ts"),
      formats: ["es"],
      fileName: "frontend",
    },
    rollupOptions: {
      external: [/^svelte($|\/)/],
    },
  },
});
