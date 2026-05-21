import type { KeyDefinition, KeyState } from "../types/index.js";

export class ModelRegistry {
	private keyStates: Map<string, KeyState>;
	private keyOrder: string[];

	constructor(keys: KeyDefinition[]) {
		this.keyStates = new Map();
		this.keyOrder = [];
		this._initConfig(keys, new Map());
	}

	private _initConfig(
		keys: KeyDefinition[],
		existingStates: Map<string, KeyState>,
	): void {
		this.keyOrder = keys.map((k) => k.id);

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

	getKeys(): KeyState[] {
		return this.keyOrder
			.map((id) => this.keyStates.get(id))
			.filter((state): state is KeyState => state !== undefined);
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

	updateConfig(keys: KeyDefinition[]): void {
		this._initConfig(keys, this.keyStates);
	}

	// Internal: get ordered key states for a specific provider
	getOrderedKeysForProvider(provider: string): KeyState[] {
		return this.keyOrder
			.map((id) => this.keyStates.get(id))
			.filter(
				(state): state is KeyState =>
					state !== undefined && state.definition.provider === provider,
			);
	}
}
