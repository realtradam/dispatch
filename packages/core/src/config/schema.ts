import type { ConfigError, DispatchConfig, KeyDefinition } from "../types/index.js";

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

	const config: DispatchConfig = {
		permissions,
		...(keys !== undefined && { keys }),
	};

	return { config, errors };
}
