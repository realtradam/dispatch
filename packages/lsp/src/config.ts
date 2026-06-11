/**
 * PURE config resolution — resolve language server configurations.
 *
 * Sources, in precedence order:
 * 1. cwd/.dispatch/lsp.json servers
 * 2. fallback cwd/opencode.json lsp
 * 3. the built-in registry
 *
 * Sidecar auto-detect: if a server's initialization has luau-lsp sourcemap
 * with autogenerate=true and a rojoProjectFile, attach a rojo sidecar.
 */

export interface ResolvedServer {
	readonly id: string;
	readonly name: string;
	readonly command: readonly string[];
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly extensions: readonly string[];
	readonly rootMarkers: readonly string[];
	readonly initialization?: Readonly<Record<string, unknown>> | undefined;
	readonly sidecar?: { readonly command: readonly string[] } | undefined;
}

export interface ServerConfig {
	readonly id?: string | undefined;
	readonly name?: string | undefined;
	readonly command: readonly string[];
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly extensions?: readonly string[] | undefined;
	readonly rootMarkers?: readonly string[] | undefined;
	readonly initialization?: Readonly<Record<string, unknown>> | undefined;
	readonly watch?: readonly string[] | undefined;
}

export interface LspJsonConfig {
	readonly servers?: Readonly<Record<string, ServerConfig>> | undefined;
}

export interface OpencodeJsonConfig {
	readonly lsp?: Readonly<Record<string, ServerConfig>> | undefined;
}

export interface ResolveServersDeps {
	readonly cwd: string;
	readonly dispatchLspJson: string | null;
	readonly opencodeJson: string | null;
	readonly exists: (path: string) => Promise<boolean>;
}

const BUILT_IN_REGISTRY: Record<string, ResolvedServer> = {
	typescript: {
		id: "typescript",
		name: "TypeScript Language Server",
		command: ["typescript-language-server", "--stdio"],
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
		rootMarkers: ["tsconfig.json", "package.json"],
	},
};

export async function resolveServers(deps: ResolveServersDeps): Promise<ResolvedServer[]> {
	const result = new Map<string, ResolvedServer>();

	if (deps.dispatchLspJson) {
		try {
			const config = JSON.parse(deps.dispatchLspJson) as LspJsonConfig;
			if (config.servers) {
				for (const [key, server] of Object.entries(config.servers)) {
					const resolved = resolveServer(key, server);
					result.set(resolved.id, resolved);
				}
			}
		} catch {
			// ignore parse errors
		}
	}

	if (result.size === 0 && deps.opencodeJson) {
		try {
			const config = JSON.parse(deps.opencodeJson) as OpencodeJsonConfig;
			if (config.lsp) {
				for (const [key, server] of Object.entries(config.lsp)) {
					const resolved = resolveServer(key, server);
					result.set(resolved.id, resolved);
				}
			}
		} catch {
			// ignore parse errors
		}
	}

	if (result.size === 0) {
		for (const [id, server] of Object.entries(BUILT_IN_REGISTRY)) {
			result.set(id, server);
		}
	}

	return [...result.values()];
}

function resolveServer(key: string, config: ServerConfig): ResolvedServer {
	const id = config.id ?? key;
	const name = config.name ?? id;
	const extensions = config.extensions ?? [];
	const rootMarkers = config.rootMarkers ?? [];

	let sidecar: { readonly command: readonly string[] } | undefined;
	if (config.watch) {
		sidecar = { command: config.watch };
	} else if (config.initialization) {
		sidecar = detectSidecar(config.initialization);
	}

	const result: ResolvedServer = {
		id,
		name,
		command: config.command,
		extensions,
		rootMarkers,
	};
	if (config.env) {
		(result as { env?: Readonly<Record<string, string>> }).env = config.env;
	}
	if (config.initialization) {
		(result as { initialization?: Readonly<Record<string, unknown>> }).initialization =
			config.initialization;
	}
	if (sidecar) {
		(result as { sidecar?: { readonly command: readonly string[] } }).sidecar = sidecar;
	}
	return result;
}

function detectSidecar(
	init: Readonly<Record<string, unknown>>,
): { readonly command: readonly string[] } | undefined {
	const luauLsp = init["luau-lsp"];
	if (!luauLsp || typeof luauLsp !== "object") return undefined;
	const luau = luauLsp as Record<string, unknown>;
	const sourcemap = luau.sourcemap;
	if (!sourcemap || typeof sourcemap !== "object") return undefined;
	const sm = sourcemap as Record<string, unknown>;
	if (sm.autogenerate !== true) return undefined;
	const rojoProjectFile = sm.rojoProjectFile;
	if (typeof rojoProjectFile !== "string") return undefined;
	return {
		command: ["rojo", "sourcemap", rojoProjectFile, "--watch", "-o", "sourcemap.json"],
	};
}
