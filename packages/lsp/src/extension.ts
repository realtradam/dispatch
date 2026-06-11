/**
 * LSP extension — manifest + activate(host).
 *
 * Builds the manager with real adapters, registers the lsp tool and
 * lspServiceHandle, and wires deactivate to manager.shutdownAll().
 */

import type { Extension, HostAPI, ServiceHandle } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { SpawnedProcess } from "./client.js";
import { LspManager } from "./manager.js";
import { createLspTool } from "./tool.js";
import type { LspServerStatus, LspService } from "./types.js";

export const lspServiceHandle: ServiceHandle<LspService> = defineService<LspService>("lsp");

function realSpawn(
	command: string[],
	opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
): SpawnedProcess {
	const env: Record<string, string | undefined> = { ...process.env };
	if (opts.env) {
		for (const [key, value] of Object.entries(opts.env)) {
			env[key] = value;
		}
	}
	const proc = Bun.spawn(command, {
		cwd: opts.cwd,
		env: env as Record<string, string>,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		stdin: proc.stdin,
		stdout: proc.stdout,
		stderr: proc.stderr,
		pid: proc.pid,
		kill: () => proc.kill(),
	};
}

function realFileWatcher(
	root: string,
	onEvent: (e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void,
): { readonly close: () => void } {
	const { watch } = require("node:fs");
	const watcher = watch(root, { recursive: true }, (eventType: string, filename: string | null) => {
		if (!filename) return;
		const fullPath = root.endsWith("/") ? `${root}${filename}` : `${root}/${filename}`;
		const type = eventType === "rename" ? "create" : "change";
		onEvent({ type, path: fullPath });
	});
	return { close: () => watcher.close() };
}

function realFs() {
	return {
		readText: async (path: string) => {
			const file = Bun.file(path);
			return file.text();
		},
		exists: async (path: string) => {
			const file = Bun.file(path);
			return file.exists();
		},
	};
}

export const extension: Extension = {
	manifest: {
		id: "lsp",
		name: "Language Server Protocol",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { spawn: true, fs: true },
		contributes: { tools: ["lsp"], services: ["lsp"] },
	},
	activate(host: HostAPI) {
		const logger = host.logger;

		const manager = new LspManager({
			spawn: realSpawn,
			fileWatcher: realFileWatcher,
			fs: realFs(),
			logger: {
				info: (msg, attrs) =>
					logger.info(msg, attrs as Record<string, string | number | boolean | null> | undefined),
				warn: (msg, attrs) =>
					logger.warn(msg, attrs as Record<string, string | number | boolean | null> | undefined),
				error: (msg, attrs) => logger.error(msg, attrs as Record<string, unknown> | undefined),
			},
		});

		const lspTool = createLspTool(manager);
		host.defineTool(lspTool);

		const service: LspService = {
			async status(cwd: string): Promise<readonly LspServerStatus[]> {
				return manager.status(cwd);
			},
		};
		host.provideService(lspServiceHandle, service);

		host.logger.info("LSP extension activated");

		// Store manager for deactivate
		(lspManagerStore as { manager: LspManager | null }).manager = manager;
	},
	deactivate() {
		const store = lspManagerStore as { manager: LspManager | null };
		store.manager?.shutdownAll();
		store.manager = null;
	},
};

// Module-scoped store for deactivate
const lspManagerStore: { manager: LspManager | null } = { manager: null };
