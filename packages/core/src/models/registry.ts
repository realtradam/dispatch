import type { KeyDefinition, KeyState, ModelDefinition } from "../types/index.js";

export class ModelRegistry {
	private models: ModelDefinition[];
	private keyStates: Map<string, KeyState>;
	private fallbackOrder: string[];

	constructor(models: ModelDefinition[], keys: KeyDefinition[], fallbackOrder: string[]) {
		this.models = [];
		this.keyStates = new Map();
		this.fallbackOrder = [];
		this._initConfig(models, keys, fallbackOrder, new Map());
	}

	private _initConfig(
		models: ModelDefinition[],
		keys: KeyDefinition[],
		fallbackOrder: string[],
		existingStates: Map<string, KeyState>,
	): void {
		this.models = [...models];
		this.fallbackOrder = this._buildFallbackOrder(keys, fallbackOrder);

		const newStates = new Map<string, KeyState>();
		for (const key of keys) {
			const existing = existingStates.get(key.id);
			if (existing) {
				// Preserve existing state but update definition
				newStates.set(key.id, { ...existing, definition: key });
			} else {
				newStates.set(key.id, { definition: key, status: "active" });
			}
		}
		this.keyStates = newStates;
	}

	private _buildFallbackOrder(keys: KeyDefinition[], fallbackOrder: string[]): string[] {
		const ordered: string[] = [];
		const keyIds = new Set(keys.map((k) => k.id));

		// Add keys from fallbackOrder first (if they exist)
		for (const id of fallbackOrder) {
			if (keyIds.has(id) && !ordered.includes(id)) {
				ordered.push(id);
			}
		}

		// Append remaining keys not in fallbackOrder
		for (const key of keys) {
			if (!ordered.includes(key.id)) {
				ordered.push(key.id);
			}
		}

		return ordered;
	}

	getModels(): ModelDefinition[] {
		return [...this.models];
	}

	getKeys(): KeyState[] {
		return this.fallbackOrder
			.map((id) => this.keyStates.get(id))
			.filter((state): state is KeyState => state !== undefined);
	}

	getModelsByTag(tag: string): ModelDefinition[] {
		return this.models.filter((m) => m.tags.includes(tag));
	}

	getAllTags(): string[] {
		const tags = new Set<string>();
		for (const model of this.models) {
			for (const tag of model.tags) {
				tags.add(tag);
			}
		}
		return [...tags];
	}

	markKeyExhausted(keyId: string, error?: string): void {
		const state = this.keyStates.get(keyId);
		if (!state) return;
		this.keyStates.set(keyId, {
			...state,
			status: "exhausted",
			lastError: error,
			exhaustedAt: Date.now(),
		});
	}

	markKeyActive(keyId: string): void {
		const state = this.keyStates.get(keyId);
		if (!state) return;
		const updated: KeyState = {
			definition: state.definition,
			status: "active",
		};
		this.keyStates.set(keyId, updated);
	}

	hasAvailableKey(provider: string): boolean {
		for (const state of this.keyStates.values()) {
			if (state.definition.provider === provider && state.status === "active") {
				return true;
			}
		}
		return false;
	}

	allKeysExhausted(): boolean {
		for (const state of this.keyStates.values()) {
			if (state.status === "active") {
				return false;
			}
		}
		return true;
	}

	updateConfig(models: ModelDefinition[], keys: KeyDefinition[], fallbackOrder: string[]): void {
		this._initConfig(models, keys, fallbackOrder, this.keyStates);
	}

	// Internal: get ordered key states for a specific provider
	getOrderedKeysForProvider(provider: string): KeyState[] {
		return this.fallbackOrder
			.map((id) => this.keyStates.get(id))
			.filter(
				(state): state is KeyState =>
					state !== undefined && state.definition.provider === provider,
			);
	}
}
