import type {
	AgentTemplate,
	ConfigError,
	DispatchConfig,
	KeyDefinition,
	ModelDefinition,
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
			errors.push({ path: `${path}.${key}`, message: "must be a string or a flat string-keyed object" });
			continue;
		}
		if (typeof value === "string") {
			if (!isValidAction(value)) {
				errors.push({ path: `${path}.${key}`, message: `invalid action "${value}"; must be "allow", "deny", or "ask"` });
				continue;
			}
		} else {
			let hasError = false;
			for (const [pattern, action] of Object.entries(value)) {
				if (!isValidAction(action)) {
					errors.push({ path: `${path}.${key}.${pattern}`, message: `invalid action "${action}"; must be "allow", "deny", or "ask"` });
					hasError = true;
				}
			}
			if (hasError) continue;
		}
		result[key] = value;
	}
	return result;
}

function validateAgentTemplate(
	raw: unknown,
	path: string,
	errors: ConfigError[],
): AgentTemplate | null {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return null;
	}

	const requiredStrings = ["name", "description", "system_prompt", "model_tag"] as const;
	for (const field of requiredStrings) {
		if (typeof raw[field] !== "string") {
			errors.push({ path: `${path}.${field}`, message: "must be a string" });
			return null;
		}
	}

	if (!Array.isArray(raw["tools"]) || !raw["tools"].every((t) => typeof t === "string")) {
		errors.push({ path: `${path}.tools`, message: "must be an array of strings" });
		return null;
	}

	const perms = validatePermissions(raw["permissions"] ?? {}, `${path}.permissions`, errors);

	return {
		name: raw["name"] as string,
		description: raw["description"] as string,
		system_prompt: raw["system_prompt"] as string,
		tools: raw["tools"] as string[],
		model_tag: raw["model_tag"] as string,
		permissions: perms,
	};
}

function validateModel(raw: unknown, path: string, errors: ConfigError[]): ModelDefinition | null {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return null;
	}
	if (typeof raw["id"] !== "string") {
		errors.push({ path: `${path}.id`, message: "must be a string" });
		return null;
	}
	if (typeof raw["provider"] !== "string") {
		errors.push({ path: `${path}.provider`, message: "must be a string" });
		return null;
	}
	if (
		!Array.isArray(raw["tags"]) ||
		raw["tags"].length === 0 ||
		!raw["tags"].every((t) => typeof t === "string")
	) {
		errors.push({ path: `${path}.tags`, message: "must be a non-empty array of strings" });
		return null;
	}
	return {
		id: raw["id"] as string,
		provider: raw["provider"] as string,
		tags: raw["tags"] as string[],
	};
}

function validateKey(raw: unknown, path: string, errors: ConfigError[]): KeyDefinition | null {
	if (!isRecord(raw)) {
		errors.push({ path, message: "must be an object" });
		return null;
	}
	if (typeof raw["id"] !== "string") {
		errors.push({ path: `${path}.id`, message: "must be a string" });
		return null;
	}
	if (typeof raw["provider"] !== "string") {
		errors.push({ path: `${path}.provider`, message: "must be a string" });
		return null;
	}
	if (typeof raw["base_url"] !== "string") {
		errors.push({ path: `${path}.base_url`, message: "must be a string" });
		return null;
	}

	// "anthropic" provider uses credentials_file instead of env
	if (raw["provider"] === "anthropic") {
		return {
			id: raw["id"] as string,
			provider: raw["provider"] as string,
			base_url: raw["base_url"] as string,
			...(typeof raw["credentials_file"] === "string" ? { credentials_file: raw["credentials_file"] } as Pick<KeyDefinition, "credentials_file"> : {}),
		};
	}

	// Other providers require env
	if (typeof raw["env"] !== "string") {
		errors.push({ path: `${path}.env`, message: "must be a string" });
		return null;
	}
	return {
		id: raw["id"] as string,
		provider: raw["provider"] as string,
		env: raw["env"] as string,
		base_url: raw["base_url"] as string,
	};
}

export function validateConfig(raw: unknown): { config: DispatchConfig; errors: ConfigError[] } {
	const errors: ConfigError[] = [];

	if (!isRecord(raw)) {
		errors.push({ path: "", message: "config must be an object" });
		return { config: { permissions: {} }, errors };
	}

	// permissions (required, but can be empty)
	const permissions = validatePermissions(raw["permissions"] ?? {}, "permissions", errors);

	// agents (optional)
	let agents: Record<string, AgentTemplate> | undefined;
	if (raw["agents"] !== undefined) {
		if (!isRecord(raw["agents"])) {
			errors.push({ path: "agents", message: "must be an object" });
		} else {
			agents = {};
			for (const [key, value] of Object.entries(raw["agents"])) {
				const agent = validateAgentTemplate(value, `agents.${key}`, errors);
				if (agent) agents[key] = agent;
			}
		}
	}

	// models (optional)
	let models: ModelDefinition[] | undefined;
	if (raw["models"] !== undefined) {
		if (!Array.isArray(raw["models"])) {
			errors.push({ path: "models", message: "must be an array" });
		} else {
			models = [];
			for (let i = 0; i < raw["models"].length; i++) {
				const model = validateModel(raw["models"][i], `models[${i}]`, errors);
				if (model) models.push(model);
			}
		}
	}

	// keys (optional)
	let keys: KeyDefinition[] | undefined;
	if (raw["keys"] !== undefined) {
		if (!Array.isArray(raw["keys"])) {
			errors.push({ path: "keys", message: "must be an array" });
		} else {
			keys = [];
			for (let i = 0; i < raw["keys"].length; i++) {
				const key = validateKey(raw["keys"][i], `keys[${i}]`, errors);
				if (key) keys.push(key);
			}
		}
	}

	// fallback (optional)
	let fallback: string[] | undefined;
	if (raw["fallback"] !== undefined) {
		if (!Array.isArray(raw["fallback"]) || !raw["fallback"].every((f) => typeof f === "string")) {
			errors.push({ path: "fallback", message: "must be an array of strings" });
		} else {
			fallback = raw["fallback"] as string[];
			// Validate that referenced key IDs exist
			const keyIds = new Set((keys ?? []).map((k) => k.id));
			for (const id of fallback) {
				if (!keyIds.has(id)) {
					errors.push({ path: "fallback", message: `key id "${id}" not found in keys` });
				}
			}
		}
	}

	// Warn if agent model_tags don't match any model
	if (agents && models) {
		const allTags = new Set(models.flatMap((m) => m.tags));
		for (const [name, agent] of Object.entries(agents)) {
			if (!allTags.has(agent.model_tag)) {
				errors.push({
					path: `agents.${name}.model_tag`,
					message: `no model found with tag "${agent.model_tag}"`,
				});
			}
		}
	}

	const config: DispatchConfig = {
		permissions,
		...(agents !== undefined && { agents }),
		...(models !== undefined && { models }),
		...(keys !== undefined && { keys }),
		...(fallback !== undefined && { fallback }),
	};

	return { config, errors };
}
