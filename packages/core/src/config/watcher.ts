import { join } from "node:path";
import { watch } from "chokidar";
import type { DispatchConfig } from "../types/index.js";
import { loadConfig } from "./loader.js";

export function createConfigWatcher(
	dir: string,
	onChange: (config: DispatchConfig) => void,
): { close(): void } {
	const tomlPath = join(dir, "dispatch.toml");
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = watch(tomlPath, {
		ignoreInitial: true,
		persistent: false,
	});

	const handleChange = () => {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			console.log(`dispatch: reloading config from ${tomlPath}`);
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
