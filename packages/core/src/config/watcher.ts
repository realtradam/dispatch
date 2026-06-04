import { join } from "node:path";
import { watch } from "chokidar";
import type { DispatchConfig } from "../types/index.js";
import { getGlobalConfigPath, loadConfig } from "./loader.js";

/**
 * Watch BOTH the HOME-directory global `dispatch.toml` and the project/working-
 * directory `dispatch.toml`. Either file changing triggers a reload that
 * re-merges global + local (via {@link loadConfig}), so hot-reload works for
 * global defaults and per-project overrides alike.
 *
 * When the global and local paths coincide (e.g. the working directory IS
 * `~/.config/dispatch`, or `DISPATCH_GLOBAL_CONFIG` points at the local file)
 * the duplicate is collapsed so chokidar only watches it once.
 */
export function createConfigWatcher(
	dir: string,
	onChange: (config: DispatchConfig) => void,
): { close(): void } {
	const localPath = join(dir, "dispatch.toml");
	const globalPath = getGlobalConfigPath();
	const paths = globalPath === localPath ? [localPath] : [globalPath, localPath];
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = watch(paths, {
		ignoreInitial: true,
		persistent: false,
	});

	const handleChange = () => {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			console.log(`dispatch: reloading config (global + ${localPath})`);
			try {
				const config = loadConfig(dir);
				onChange(config);
			} catch (err) {
				console.warn(
					`dispatch: retaining last known config due to parse error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}, 300);
	};

	watcher.on("change", handleChange);
	watcher.on("add", handleChange);
	watcher.on("unlink", handleChange);

	watcher.on("error", (err) => {
		console.warn(
			`dispatch: config watcher error: ${err instanceof Error ? err.message : String(err)}`,
		);
	});

	return {
		close() {
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			watcher.close().catch((err) => {
				console.warn(
					`dispatch: error closing config watcher: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		},
	};
}

/**
 * Watch a SINGLE directory's `dispatch.toml` (no global merge, no reload — just
 * a debounced change signal). Used by the agent manager to invalidate its
 * per-directory LSP cache when a tab's effective working directory is a
 * SUBDIRECTORY with its own `dispatch.toml`: the main `createConfigWatcher`
 * only watches the root + global configs, so without this a nested config edit
 * would never clear `lspServersByDir[subdir]` and agents there would keep using
 * stale LSP servers until a root-config change or restart.
 *
 * `onChange` fires (debounced) on add/change/unlink of `<dir>/dispatch.toml`.
 */
export function watchDirConfig(dir: string, onChange: () => void): { close(): void } {
	const tomlPath = join(dir, "dispatch.toml");
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = watch(tomlPath, {
		ignoreInitial: true,
		persistent: false,
	});

	const handleChange = () => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			try {
				onChange();
			} catch (err) {
				console.warn(
					`dispatch: dir config watcher onChange error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}, 300);
	};

	watcher.on("change", handleChange);
	watcher.on("add", handleChange);
	watcher.on("unlink", handleChange);
	watcher.on("error", (err) => {
		console.warn(
			`dispatch: dir config watcher error: ${err instanceof Error ? err.message : String(err)}`,
		);
	});

	return {
		close() {
			if (debounceTimer !== null) {
				clearTimeout(debounceTimer);
				debounceTimer = null;
			}
			watcher.close().catch((err) => {
				console.warn(
					`dispatch: error closing dir config watcher: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		},
	};
}
