/**
 * Shell — thin imperative layer that owns the Bun.serve WebSocket server.
 *
 * All decision logic lives in router.ts (pure, unit-tested).
 * This file handles I/O only: WS accept, JSON parse/stringify,
 * provider.subscribe wiring, server lifecycle.
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { SurfaceClientMessage, SurfaceServerMessage } from "@dispatch/ui-contract";
import { manifest } from "./manifest.js";
import { catalogMessage, routeClientMessage } from "./router.js";

/** Active provider subscriptions for a single WS connection. */
interface ConnectionState {
	readonly subs: Set<string>;
	readonly providerDisposers: Map<string, () => void>;
}

type Ws = Bun.ServerWebSocket<ConnectionState>;

export function createTransportWsExtension(): Extension {
	let server: ReturnType<typeof Bun.serve<ConnectionState>> | undefined;

	return {
		manifest,
		async activate(host: HostAPI) {
			const registry: SurfaceRegistry = host.getService(surfaceRegistryHandle);
			const logger = host.logger;
			const port = host.config.get<number>("surfaceWsPort") ?? 24205;

			function send(ws: Ws, msg: SurfaceServerMessage): void {
				try {
					ws.send(JSON.stringify(msg));
				} catch {
					// Connection may have been dropped; swallow.
				}
			}

			function subscribeToProvider(
				ws: Ws,
				provider: SurfaceProvider,
				surfaceId: string,
				state: ConnectionState,
			): void {
				if (!provider.subscribe || state.providerDisposers.has(surfaceId)) {
					return;
				}
				const dispose = provider.subscribe(() => {
					try {
						const spec = provider.getSpec();
						if (spec instanceof Promise) {
							spec
								.then((s) => send(ws, { type: "update", update: { surfaceId, spec: s } }))
								.catch(() => {});
						} else {
							send(ws, { type: "update", update: { surfaceId, spec } });
						}
					} catch {
						// Provider threw — log but don't kill the connection.
					}
				});
				state.providerDisposers.set(surfaceId, dispose);
			}

			function unsubscribeFromProvider(state: ConnectionState, surfaceId: string): void {
				const dispose = state.providerDisposers.get(surfaceId);
				if (dispose) {
					dispose();
					state.providerDisposers.delete(surfaceId);
				}
			}

			server = Bun.serve<ConnectionState>({
				port,
				fetch(req, srv) {
					const initial: ConnectionState = {
						subs: new Set(),
						providerDisposers: new Map(),
					};
					if (srv.upgrade(req, { data: initial })) return;
					return new Response("expected websocket", { status: 426 });
				},
				websocket: {
					open(ws) {
						send(ws, catalogMessage(registry));
					},

					message(ws, message) {
						const state = ws.data;
						if (!state) return;

						let parsed: SurfaceClientMessage;
						try {
							parsed = JSON.parse(String(message)) as SurfaceClientMessage;
						} catch {
							send(ws, { type: "error", message: "Invalid JSON" });
							return;
						}

						const result = routeClientMessage(registry, state.subs, parsed);

						// Apply sub change.
						if (result.subChange) {
							if (result.subChange.op === "add") {
								state.subs.add(result.subChange.surfaceId);
								const provider = registry.getSurface(result.subChange.surfaceId);
								if (provider) {
									subscribeToProvider(ws, provider, result.subChange.surfaceId, state);
								}
							} else {
								state.subs.delete(result.subChange.surfaceId);
								unsubscribeFromProvider(state, result.subChange.surfaceId);
							}
						}

						// Send replies.
						for (const reply of result.replies) {
							send(ws, reply);
						}

						// Perform invoke if signalled.
						if (result.invoke) {
							const provider = registry.getSurface(result.invoke.surfaceId);
							if (provider) {
								try {
									const r = provider.invoke(result.invoke.actionId, result.invoke.payload);
									if (r instanceof Promise) {
										r.catch(() => {});
									}
								} catch {
									// Provider threw on invoke — log but don't kill the connection.
								}
							}
						}
					},

					close(ws) {
						const state = ws.data;
						if (state) {
							for (const dispose of state.providerDisposers.values()) {
								dispose();
							}
						}
					},
				},
			});

			logger.info?.("transport-ws: surface WebSocket listening", { port });
		},

		deactivate() {
			if (server) {
				server.stop();
				server = undefined;
			}
		},
	};
}
