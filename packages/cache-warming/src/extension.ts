import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { cacheWarmHandle, turnSettled, turnStarted } from "@dispatch/session-orchestrator";
import type { SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { SurfaceSpec } from "@dispatch/ui-contract";
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

function buildSurfaceSpec(
	_conversationId: string | undefined,
	enabled: boolean,
	lastPct: number | null,
): SurfaceSpec {
	const pctDisplay = lastPct === null ? "—" : `${lastPct}%`;
	return {
		id: "cache-warming",
		region: "side",
		title: "Cache Warming",
		fields: [
			{
				kind: "toggle",
				label: "Enabled",
				value: enabled,
				action: { actionId: "cache-warming/toggle" },
			},
			{
				kind: "stat",
				label: "Last Cache %",
				value: pctDisplay,
			},
		],
	};
}

export function activate(host: HostAPI): void {
	const warmService = host.getService(cacheWarmHandle);
	const registry = host.getService(surfaceRegistryHandle);
	const storage = host.storage("cache-warming");

	let currentConversationId: string | undefined;

	// Timer wrapper: setTimeout/clearTimeout return Timeout in Node types,
	// but our TimerDeps uses number ids. Map between them.
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
		onSurfaceChange: () => {
			// Surface subscribers will re-fetch on next getSpec()
		},
	});

	host.on(turnStarted, (payload) => {
		currentConversationId = payload.conversationId;
		warmer.onTurnStarted(payload.conversationId);
	});

	host.on(turnSettled, (payload) => {
		currentConversationId = payload.conversationId;
		warmer.onTurnSettled(payload.conversationId, {
			...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
			...(payload.modelName !== undefined ? { modelName: payload.modelName } : {}),
		});
	});

	const provider: SurfaceProvider = {
		catalogEntry: {
			id: "cache-warming",
			region: "side",
			title: "Cache Warming",
		},
		getSpec() {
			const convId = currentConversationId;
			const state =
				convId !== undefined ? warmer.getState(convId) : { enabled: true, lastPct: null };
			return buildSurfaceSpec(convId, state.enabled, state.lastPct);
		},
		async invoke(actionId, payload) {
			const pl = payload as Record<string, unknown> | undefined;
			const convId =
				(typeof pl?.conversationId === "string" ? pl.conversationId : undefined) ??
				currentConversationId;
			if (convId === undefined) return;

			if (actionId === "cache-warming/toggle") {
				const current = warmer.getState(convId);
				await warmer.setEnabled(convId, !current.enabled);
			}
		},
	};

	registry.register(provider);

	host.logger.info("cache-warming: registered");
}

export const extension: Extension = {
	manifest,
	activate,
};
