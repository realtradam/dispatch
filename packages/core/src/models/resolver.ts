import type { ResolvedModel } from "../types/index.js";
import type { ModelRegistry } from "./registry.js";

export class ModelResolver {
	private registry: ModelRegistry;

	constructor(registry: ModelRegistry) {
		this.registry = registry;
	}

	resolve(tag: string): ResolvedModel | null {
		const models = this.registry.getModelsByTag(tag);
		const keys = this.registry.getKeys();

		for (const keyState of keys) {
			if (keyState.status !== "active") continue;
			const model = models.find((m) => m.provider === keyState.definition.provider);
			if (model) {
				return { model, key: keyState.definition };
			}
		}

		return null;
	}

	async waitForKey(
		tag: string,
		options?: {
			pollIntervalMs?: number;
			signal?: AbortSignal;
			onWaiting?: () => void;
			onResume?: () => void;
		},
	): Promise<ResolvedModel | null> {
		const pollIntervalMs = options?.pollIntervalMs ?? 60000;
		const signal = options?.signal;

		// Try immediately first
		const immediate = this.resolve(tag);
		if (immediate) return immediate;

		// Check if aborted before entering wait state
		if (signal?.aborted) return null;

		options?.onWaiting?.();

		return new Promise<ResolvedModel | null>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | null = null;

			const cleanup = () => {
				if (timer !== null) {
					clearTimeout(timer);
					timer = null;
				}
			};

			const onAbort = () => {
				cleanup();
				resolve(null);
			};

			if (signal) {
				signal.addEventListener("abort", onAbort, { once: true });
			}

			const poll = () => {
				if (signal?.aborted) {
					resolve(null);
					return;
				}

				const result = this.resolve(tag);
				if (result) {
					if (signal) {
						signal.removeEventListener("abort", onAbort);
					}
					options?.onResume?.();
					resolve(result);
					return;
				}

				timer = setTimeout(poll, pollIntervalMs);
			};

			timer = setTimeout(poll, pollIntervalMs);
		});
	}
}
