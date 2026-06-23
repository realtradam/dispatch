/**
 * system-prompt extension — manifest + activate(host).
 *
 * Builds the service with real Bun-backed adapters (Bun.file for fs,
 * Bun.spawn for git), persists the template + resolved prompts via a namespaced
 * storage, and provides the service through `systemPromptHandle`.
 */
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { GitSpawnResult, ResolverAdapters } from "./resolver.js";
import { createSystemPromptService } from "./service.js";
import { systemPromptHandle } from "./types.js";

export const manifest: Manifest = {
	id: "system-prompt",
	name: "System Prompt",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	dependsOn: [],
	capabilities: { fs: true, spawn: true },
	contributes: { services: ["system-prompt"] },
};

/** Run a command and capture stdout/stderr (used for git). */
async function realSpawn(
	command: readonly string[],
	opts: { readonly cwd: string },
): Promise<GitSpawnResult> {
	const proc = Bun.spawn([...command], {
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		Bun.readableStreamToText(proc.stdout),
		Bun.readableStreamToText(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function realFs() {
	return {
		readText: async (path: string): Promise<string> => Bun.file(path).text(),
		exists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
	};
}

const adapters: ResolverAdapters = { spawn: realSpawn, fs: realFs() };

export function activate(host: HostAPI): void {
	const storage = host.storage("system-prompt");
	const service = createSystemPromptService({ storage, adapters });
	host.provideService(systemPromptHandle, service);
	host.logger.info("system-prompt: activated");
}

export const extension: Extension = {
	manifest,
	activate,
};
