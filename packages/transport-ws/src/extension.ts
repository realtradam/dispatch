/**
 * Shell — thin imperative layer that owns the Bun.serve WebSocket server.
 *
 * All decision logic lives in router.ts (pure, unit-tested).
 * This file handles I/O only: WS accept, JSON parse/stringify,
 * provider.subscribe wiring, orchestrator turn-streaming, server lifecycle.
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import { sessionOrchestratorHandle } from "@dispatch/session-orchestrator";
import type { SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { WsClientMessage, WsServerMessage } from "@dispatch/transport-contract";
import { manifest } from "./manifest.js";
import { catalogMessage, routeClientMessage } from "./router.js";

/** Active provider subscriptions + chat abort controller for a single WS connection. */
interface ConnectionState {
	readonly subs: Set<string>;
	readonly providerDisposers: Map<string, () => void>;
	/** AbortController cancelled when the socket closes — aborts in-flight turns. */
	readonly abortController: AbortController;
}

type Ws = Bun.ServerWebSocket<ConnectionState>;

export function createTransportWsExtension(): Extension {
	let server: ReturnType<typeof Bun.serve<ConnectionState>> | undefined;

	return {
		manifest,
		async activate(host: HostAPI) {
			const registry: SurfaceRegistry = host.getService(surfaceRegistryHandle);
			const orchestrator: SessionOrchestrator = host.getService(sessionOrchestratorHandle);
			const logger = host.logger;
			const port = host.config.get<number>("surfaceWsPort") ?? 24205;

			function send(ws: Ws, msg: WsServerMessage): void {
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

			/**
			 * Drive one chat turn through the orchestrator. Error-isolated:
			 * a throw/reject sends a chat.error to the socket and never kills
			 * the connection or affects surface ops / other connections.
			 */
			async function handleChatTurn(
				ws: Ws,
				state: ConnectionState,
				conversationId: string | undefined,
				text: string,
				model: string | undefined,
				cwd: string | undefined,
			): Promise<void> {
				const resolvedId = conversationId ?? crypto.randomUUID();
				try {
					await orchestrator.handleMessage({
						conversationId: resolvedId,
						text,
						...(model !== undefined ? { modelName: model } : {}),
						...(cwd !== undefined ? { cwd } : {}),
						signal: state.abortController.signal,
						onEvent(event) {
							send(ws, { type: "chat.delta", event });
						},
					});
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : "unknown orchestrator error";
					send(ws, { type: "chat.error", conversationId: resolvedId, message });
					logger.warn?.("transport-ws: chat turn failed", {
						conversationId: resolvedId,
						error: message,
					});
				}
			}

			server = Bun.serve<ConnectionState>({
				port,
				fetch(req, srv) {
					const initial: ConnectionState = {
						subs: new Set(),
						providerDisposers: new Map(),
						abortController: new AbortController(),
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

						let parsed: WsClientMessage;
						try {
							parsed = JSON.parse(String(message)) as WsClientMessage;
						} catch {
							send(ws, { type: "error", message: "Invalid JSON" });
							return;
						}

						const result = routeClientMessage(registry, state.subs, parsed);

						switch (result.kind) {
							case "surface": {
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
								break;
							}

							case "chat": {
								// Fire-and-forget the turn; errors are caught inside handleChatTurn.
								void handleChatTurn(
									ws,
									state,
									result.conversationId,
									result.message,
									result.model,
									result.cwd,
								);
								break;
							}

							case "chat-error": {
								send(ws, {
									type: "chat.error",
									...(result.conversationId !== undefined
										? { conversationId: result.conversationId }
										: {}),
									message: result.errorMessage,
								});
								break;
							}
						}
					},

					close(ws) {
						const state = ws.data;
						if (state) {
							// Abort any in-flight chat turns.
							state.abortController.abort();
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
