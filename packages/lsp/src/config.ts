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
  /**
   * Which config source this server was resolved from: `".dispatch/lsp.json"`,
   * `"opencode.json"`, or `"built-in"`. Omitted when not yet resolved. Mirrors
   * the wire `LspServerInfo.configSource` so config-shadow debugging surfaces
   * to the status caller (a broken `.dispatch/lsp.json` silently shadowing
   * `opencode.json`).
   */
  readonly configSource?: string | undefined;
}

/** Which config source a resolved server came from. */
export type ConfigSource = ".dispatch/lsp.json" | "opencode.json" | "built-in";

/** Result of resolving servers: the servers + whether `opencode.json`'s lsp key
 * was silently shadowed by a present `.dispatch/lsp.json`. */
export interface ResolveResult {
  readonly servers: readonly ResolvedServer[];
  readonly shadowed: boolean;
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
    configSource: "built-in",
  },
};

export async function resolveServers(deps: ResolveServersDeps): Promise<ResolveResult> {
  const result = new Map<string, ResolvedServer>();

  // Parse opencode.json once — used both as the fallback source and to detect
  // whether a present `.dispatch/lsp.json` silently shadows its `lsp` key.
  let opencodeConfig: OpencodeJsonConfig | null = null;
  if (deps.opencodeJson) {
    try {
      opencodeConfig = JSON.parse(deps.opencodeJson) as OpencodeJsonConfig;
    } catch {
      // ignore parse errors
    }
  }
  const opencodeHasLsp = !!opencodeConfig?.lsp && Object.keys(opencodeConfig.lsp).length > 0;

  // 1. cwd/.dispatch/lsp.json (highest precedence)
  let dispatchHadServers = false;
  if (deps.dispatchLspJson) {
    try {
      const config = JSON.parse(deps.dispatchLspJson) as LspJsonConfig;
      if (config.servers) {
        for (const [key, server] of Object.entries(config.servers)) {
          const resolved = resolveServer(key, server, ".dispatch/lsp.json");
          result.set(resolved.id, resolved);
        }
        dispatchHadServers = result.size > 0;
      }
    } catch {
      // ignore parse errors
    }
  }

  // 2. fallback cwd/opencode.json lsp (only when dispatch yielded nothing)
  if (result.size === 0 && opencodeConfig?.lsp) {
    for (const [key, server] of Object.entries(opencodeConfig.lsp)) {
      const resolved = resolveServer(key, server, "opencode.json");
      result.set(resolved.id, resolved);
    }
  }

  // 3. the built-in registry (when nothing else resolved)
  if (result.size === 0) {
    for (const [, server] of Object.entries(BUILT_IN_REGISTRY)) {
      result.set(server.id, server);
    }
  }

  // `.dispatch/lsp.json` silently shadows `opencode.json`'s lsp key when both
  // declare servers — the opencode entry is skipped with no warning otherwise.
  const shadowed = dispatchHadServers && opencodeHasLsp;
  return { servers: [...result.values()], shadowed };
}

function resolveServer(
  key: string,
  config: ServerConfig,
  configSource: ConfigSource,
): ResolvedServer {
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
    configSource,
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

/**
 * A stable fingerprint of a resolved server's config — the bytes that decide
 * HOW a server spawns (command, env, initialization, root markers, …). It is
 * independent of object key insertion order, so two `status()` calls over an
 * UNCHANGED config produce identical fingerprints. The manager compares it
 * against the fingerprint captured when a server was marked broken: a change
 * means the config was edited (a discrete event → cannot storm) and the server
 * should be retried; identical means "still the same broken config" and the
 * server stays broken until a bounded backoff elapses.
 */
export function configFingerprint(server: ResolvedServer): string {
  return stableStringify(server);
}

/** Deterministic JSON: object keys sorted at every nesting level. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
