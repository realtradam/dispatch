import type {
	ConfigError,
	DispatchConfig,
	KeyDefinition,
	LspServerConfig,
} from "../types/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every((v) => typeof v === "string");
}

function isValidAction(value: string): boolean {
	return value === "allow" || value === "deny" || value === "ask";
}

function isPermissionsValue(value: unknown): value is string | Record<string, string> {
	return typeof value === "string" || isStringRecord(value);
}

function validatePermissions(
	raw: unknown,
	path: string,
	errors: ConfigError[],
): Record<string, string | Record<string, string>> {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return {};
	}
	const result: Record<string, string | Record<string, string>> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isPermissionsValue(value)) {
			errors.push({
				path: `${path}.${key}`,
				message: "must be a string or a flat string-keyed object",
			});
			continue;
		}
		if (typeof value === "string") {
			if (!isValidAction(value)) {
				errors.push({
					path: `${path}.${key}`,
					message: `invalid action "${value}"; must be "allow", "deny", or "ask"`,
				});
				continue;
			}
		} else {
			let hasError = false;
			for (const [pattern, action] of Object.entries(value)) {
				if (!isValidAction(action)) {
					errors.push({
						path: `${path}.${key}.${pattern}`,
						message: `invalid action "${action}"; must be "allow", "deny", or "ask"`,
					});
					hasError = true;
				}
			}
			if (hasError) continue;
		}
		result[key] = value;
	}
	return result;
}

function validateKey(raw: unknown, path: string, errors: ConfigError[]): KeyDefinition | null {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return null;
	}
	if (typeof raw.id !== "string") {
		errors.push({ path: `${path}.id`, message: "must be a string" });
		return null;
	}
	if (typeof raw.provider !== "string") {
		errors.push({ path: `${path}.provider`, message: "must be a string" });
		return null;
	}
	if (typeof raw.base_url !== "string") {
		errors.push({ path: `${path}.base_url`, message: "must be a string" });
		return null;
	}

	// "anthropic" provider uses credentials_file instead of env
	if (raw.provider === "anthropic") {
		return {
			id: raw.id as string,
			provider: raw.provider as string,
			base_url: raw.base_url as string,
			...(typeof raw.credentials_file === "string"
				? ({ credentials_file: raw.credentials_file } as Pick<KeyDefinition, "credentials_file">)
				: {}),
		};
	}

	// Other providers: env is optional (keys can be stored in DB)
	return {
		id: raw.id as string,
		provider: raw.provider as string,
		base_url: raw.base_url as string,
		...(typeof raw.env === "string" ? { env: raw.env } : {}),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function validateLspServer(
	raw: unknown,
	path: string,
	errors: ConfigError[],
): LspServerConfig | null {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return null;
	}

	const disabled = raw.disabled === true;

	// `command` is required and must be a non-empty string array unless the
	// entry is explicitly disabled (a disabled entry is skipped wholesale).
	if (!disabled) {
		if (!isStringArray(raw.command) || raw.command.length === 0) {
			errors.push({
				path: `${path}.command`,
				message: "must be a non-empty array of strings",
			});
			return null;
		}
		// `extensions` is required for custom servers — without it the client
		// cannot know which files should activate the server.
		if (!isStringArray(raw.extensions) || raw.extensions.length === 0) {
			errors.push({
				path: `${path}.extensions`,
				message: 'must be a non-empty array of strings (e.g. [".luau"])',
			});
			return null;
		}
	} else {
		// Disabled entries still must not carry a malformed command/extensions
		// if present, but we do not require them.
		if (raw.command !== undefined && !isStringArray(raw.command)) {
			errors.push({ path: `${path}.command`, message: "must be an array of strings" });
			return null;
		}
		if (raw.extensions !== undefined && !isStringArray(raw.extensions)) {
			errors.push({ path: `${path}.extensions`, message: "must be an array of strings" });
			return null;
		}
	}

	if (raw.env !== undefined && !isStringRecord(raw.env)) {
		errors.push({
			path: `${path}.env`,
			message: "must be a flat string-keyed object",
		});
		return null;
	}

	if (raw.initialization !== undefined && !isRecord(raw.initialization)) {
		errors.push({
			path: `${path}.initialization`,
			message: "must be an object",
		});
		return null;
	}

	const server: LspServerConfig = {
		command: (raw.command as string[] | undefined) ?? [],
		extensions: (raw.extensions as string[] | undefined) ?? [],
		...(isStringRecord(raw.env) ? { env: raw.env } : {}),
		...(isRecord(raw.initialization)
			? { initialization: raw.initialization as Record<string, unknown> }
			: {}),
		...(disabled ? { disabled: true } : {}),
	};
	return server;
}

function validateLsp(
	raw: unknown,
	path: string,
	errors: ConfigError[],
): Record<string, LspServerConfig> | undefined {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return undefined;
	}
	const result: Record<string, LspServerConfig> = {};
	for (const [id, value] of Object.entries(raw)) {
		const server = validateLspServer(value, `${path}.${id}`, errors);
		if (server) result[id] = server;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export function validateConfig(raw: unknown): { config: DispatchConfig; errors: ConfigError[] } {
	const errors: ConfigError[] = [];

	if (!isRecord(raw)) {
		errors.push({ path: "", message: "config must be an object" });
		return { config: { permissions: {} }, errors };
	}

	// permissions (required, but can be empty)
	const permissions = validatePermissions(raw.permissions ?? {}, "permissions", errors);

	// keys (optional)
	let keys: KeyDefinition[] | undefined;
	if (raw.keys !== undefined) {
		if (!Array.isArray(raw.keys)) {
			errors.push({ path: "keys", message: "must be an array" });
		} else {
			keys = [];
			for (let i = 0; i < raw.keys.length; i++) {
				const key = validateKey(raw.keys[i], `keys[${i}]`, errors);
				if (key) keys.push(key);
			}
		}
	}

	// lsp (optional)
	let lsp: Record<string, LspServerConfig> | undefined;
	if (raw.lsp !== undefined) {
		lsp = validateLsp(raw.lsp, "lsp", errors);
	}

	const config: DispatchConfig = {
		permissions,
		...(keys !== undefined && { keys }),
		...(lsp !== undefined && { lsp }),
	};

	return { config, errors };
}
