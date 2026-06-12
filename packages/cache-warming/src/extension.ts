import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import {
	cacheWarmHandle,
	conversationClosed,
	turnSettled,
	turnStarted,
	warmCompleted,
} from "@dispatch/session-orchestrator";
import type { SurfaceContext, SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { SurfaceSpec } from "@dispatch/ui-contract";
import {
	buildConversationSpec,
	buildDefaultSpec,
	parseIntervalPayload,
	secondsToMs,
} from "./pure.js";
import { createCacheWarmer } from "./warmer.js";

export const manifest: Manifest = {
	id: "cache-warming",
	name: "Cache Warming",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	dependsOn: ["session-orchestrator", "surface-registry"],
	capabilities: {},
	contributes: {
		services: ["cache-warming/surface"],
	},
};

export function activate(host: HostAPI): void {
	const warmService = host.getService(cacheWarmHandle);
	const registry = host.getService(surfaceRegistryHandle);
	const storage = host.storage("cache-warming");

	const subscribers = new Set<() => void>();

	const timeoutMap = new Map<number, ReturnType<typeof setTimeout>>();
	let nextTimerId = 1;

	const warmer = createCacheWarmer({
		warm: warmService.warm,
		storage,
		logger: host.logger,
		timers: {
			setTimer(fn, ms) {
				const id = nextTimerId++;
				timeoutMap.set(id, setTimeout(fn, ms));
				return id;
			},
			clearTimer(id) {
				const timeout = timeoutMap.get(id);
				if (timeout !== undefined) {
					clearTimeout(timeout);
					timeoutMap.delete(id);
				}
			},
		},
		now: () => Date.now(),
		onSurfaceChange: () => {
			for (const notify of subscribers) {
				notify();
			}
		},
	});

	host.on(turnStarted, (payload) => {
		warmer.onTurnStarted(payload.conversationId);
	});

	host.on(turnSettled, (payload) => {
		warmer.onTurnSettled(payload.conversationId, {
			...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
			...(payload.modelName !== undefined ? { modelName: payload.modelName } : {}),
		});
	});

	host.on(warmCompleted, (payload) => {
		warmer.onWarmCompleted(payload);
	});

	host.on(conversationClosed, (payload) => {
		// Sync part (cancel + disable) runs before the first await inside;
		// only the settings persist is deferred.
		void warmer.onConversationClosed(payload.conversationId);
	});

	function getSpec(context?: SurfaceContext): SurfaceSpec {
		const convId = context?.conversationId;
		if (convId === undefined) {
			return buildDefaultSpec();
		}
		const state = warmer.getState(convId);
		return buildConversationSpec(
			state.enabled,
			state.intervalMs,
			state.lastPct,
			state.lastExpectedPct,
			state.nextWarmAt,
			state.lastWarmAt,
		);
	}

	async function invoke(
		actionId: string,
		payload?: unknown,
		context?: SurfaceContext,
	): Promise<void> {
		const convId = context?.conversationId;
		if (convId === undefined) return;

		if (actionId === "cache-warming/toggle") {
			const current = warmer.getState(convId);
			await warmer.setEnabled(convId, !current.enabled);
		}

		if (actionId === "cache-warming/set-interval") {
			const seconds = parseIntervalPayload(payload);
			if (seconds === null) return;
			const ms = secondsToMs(seconds);
			if (ms === null) return;
			await warmer.setIntervalMs(convId, ms);
		}
	}

	const provider: SurfaceProvider = {
		catalogEntry: {
			id: "cache-warming",
			region: "side",
			title: "Cache Warming",
			scope: "conversation",
		},
		getSpec,
		invoke,
		subscribe(onChange) {
			subscribers.add(onChange);
			return () => {
				subscribers.delete(onChange);
			};
		},
	};

	registry.register(provider);

	host.logger.info("cache-warming: registered");
}

export const extension: Extension = {
	manifest,
	activate,
};
