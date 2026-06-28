/**
 * Shell — thin imperative layer that owns the Bun.serve WebSocket server.
 *
 * All decision logic lives in router.ts (pure, unit-tested).
 * This file handles I/O only: WS accept, JSON parse/stringify,
 * provider.subscribe wiring, orchestrator turn-streaming, server lifecycle.
 */

import type { Extension, HostAPI } from "@dispatch/kernel";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import {
  conversationCompacted,
  conversationOpened,
  conversationStatusChanged,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import type { SurfaceContext, SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { WsClientMessage, WsServerMessage } from "@dispatch/transport-contract";
import { manifest } from "./manifest.js";
import { catalogMessage, routeClientMessage, subKey } from "./router.js";

/** Active provider subscriptions + chat subscription disposers for a single WS connection. */
interface ConnectionState {
  readonly subs: Set<string>;
  readonly providerDisposers: Map<string, () => void>;
  /** Per-conversation chat subscription disposers (orchestrator.subscribe). */
  readonly chatSubscriptions: Map<string, () => void>;
}

type Ws = Bun.ServerWebSocket<ConnectionState>;

export function createTransportWsExtension(): Extension {
  let server: ReturnType<typeof Bun.serve<ConnectionState>> | undefined;
  /** Every currently-connected WS client — used for global fan-out broadcasts. */
  const connections = new Set<Ws>();
  /** Disposers for host hook subscriptions (drained on deactivate). */
  const disposers: Array<() => void> = [];

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

      /** Broadcast a message to EVERY connected WS client (global fan-out). */
      function broadcast(msg: WsServerMessage): void {
        for (const ws of connections) {
          send(ws, msg);
        }
      }

      /**
       * Ensure this connection is subscribed to a conversation's chat events.
       * Idempotent — no-op if already subscribed. The orchestrator replays
       * buffered events to new subscribers (late-join), then streams live.
       */
      function ensureChatSubscribed(ws: Ws, state: ConnectionState, conversationId: string): void {
        if (state.chatSubscriptions.has(conversationId)) {
          return;
        }
        const unsubscribe = orchestrator.subscribe(conversationId, (event) => {
          send(ws, { type: "chat.delta", event });
        });
        state.chatSubscriptions.set(conversationId, unsubscribe);
      }

      function subscribeToProvider(
        ws: Ws,
        provider: SurfaceProvider,
        surfaceId: string,
        conversationId: string | undefined,
        state: ConnectionState,
      ): void {
        const key = subKey(surfaceId, conversationId);
        if (!provider.subscribe || state.providerDisposers.has(key)) {
          return;
        }
        const context: SurfaceContext | undefined =
          conversationId !== undefined ? { conversationId } : undefined;
        const dispose = provider.subscribe(() => {
          try {
            const spec = provider.getSpec(context);
            if (spec instanceof Promise) {
              spec
                .then((s) =>
                  send(ws, {
                    type: "update",
                    update: {
                      surfaceId,
                      spec: s,
                      ...(conversationId !== undefined ? { conversationId } : {}),
                    },
                  }),
                )
                .catch(() => {});
            } else {
              send(ws, {
                type: "update",
                update: {
                  surfaceId,
                  spec,
                  ...(conversationId !== undefined ? { conversationId } : {}),
                },
              });
            }
          } catch {
            // Provider threw — log but don't kill the connection.
          }
        });
        state.providerDisposers.set(key, dispose);
      }

      function unsubscribeFromProvider(state: ConnectionState, key: string): void {
        const dispose = state.providerDisposers.get(key);
        if (dispose) {
          dispose();
          state.providerDisposers.delete(key);
        }
      }

      // Broadcast a `conversation.open` WS message to ALL connected clients
      // whenever the orchestrator signals a conversation was opened (e.g. the
      // CLI `--open` flag). The frontend decides whether to open/focus a tab —
      // the backend just signals. This is a GLOBAL fan-out (like the catalog),
      // NOT a per-conversation chat broadcast. The payload's `workspaceId`
      // is the conversation's actual persisted workspace (resolved by the
      // orchestrator from the store), so a frontend opens/focuses the tab in
      // the correct workspace.
      disposers.push(
        host.on(conversationOpened, ({ conversationId, workspaceId }) => {
          broadcast({ type: "conversation.open", conversationId, workspaceId });
        }),
      );

      // Broadcast `conversation.statusChanged` to all connected clients so
      // tabs sync across devices in real time. `workspaceId` is the
      // conversation's actual persisted workspace (resolved by the
      // orchestrator from the store), forwarded so a frontend syncs the tab
      // in the correct workspace.
      disposers.push(
        host.on(conversationStatusChanged, ({ conversationId, status, workspaceId }) => {
          broadcast({
            type: "conversation.statusChanged",
            conversationId,
            status,
            workspaceId,
          });
        }),
      );

      // Broadcast `conversation.compacted` to all connected clients so
      // the FE reloads the conversation history after compaction.
      disposers.push(
        host.on(
          conversationCompacted,
          ({ conversationId, newConversationId, messagesSummarized, messagesKept }) => {
            broadcast({
              type: "conversation.compacted",
              conversationId,
              newConversationId,
              messagesSummarized,
              messagesKept,
            });
          },
        ),
      );

      server = Bun.serve<ConnectionState>({
        port,
        fetch(req, srv) {
          const initial: ConnectionState = {
            subs: new Set(),
            providerDisposers: new Map(),
            chatSubscriptions: new Map(),
          };
          if (srv.upgrade(req, { data: initial })) return;
          return new Response("expected websocket", { status: 426 });
        },
        websocket: {
          open(ws) {
            connections.add(ws);
            logger.debug("transport-ws: connection open");
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
                // Log surface-op errors (unknown surface or invoke failure).
                for (const reply of result.replies) {
                  if (reply.type === "error") {
                    logger.warn?.("transport-ws: surface-op error", {
                      ...(reply.surfaceId !== undefined ? { surfaceId: reply.surfaceId } : {}),
                      reason: reply.message,
                    });
                  }
                }

                // Apply sub change.
                if (result.subChange) {
                  const key = subKey(result.subChange.surfaceId, result.subChange.conversationId);
                  if (result.subChange.op === "add") {
                    state.subs.add(key);
                    const provider = registry.getSurface(result.subChange.surfaceId);
                    if (provider) {
                      subscribeToProvider(
                        ws,
                        provider,
                        result.subChange.surfaceId,
                        result.subChange.conversationId,
                        state,
                      );
                    }
                  } else {
                    state.subs.delete(key);
                    unsubscribeFromProvider(state, key);
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
                    const context: SurfaceContext | undefined =
                      result.invoke.conversationId !== undefined
                        ? { conversationId: result.invoke.conversationId }
                        : undefined;
                    try {
                      const r = provider.invoke(
                        result.invoke.actionId,
                        result.invoke.payload,
                        context,
                      );
                      if (r instanceof Promise) {
                        r.catch(() => {});
                      }
                    } catch (err: unknown) {
                      const reason = err instanceof Error ? err.message : "invoke failed";
                      logger.warn?.("transport-ws: surface-op error", {
                        surfaceId: result.invoke.surfaceId,
                        actionId: result.invoke.actionId,
                        reason,
                      });
                    }
                  }
                }
                break;
              }

              case "chat": {
                const resolvedId = result.conversationId ?? crypto.randomUUID();
                // Auto-subscribe the sender so it sees the turn's events.
                ensureChatSubscribed(ws, state, resolvedId);
                // Start the turn detached from this connection.
                const startResult = orchestrator.startTurn({
                  conversationId: resolvedId,
                  text: result.message,
                  ...(result.model !== undefined ? { modelName: result.model } : {}),
                  ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
                  ...(result.reasoningEffort !== undefined
                    ? { reasoningEffort: result.reasoningEffort }
                    : {}),
                  ...(result.workspaceId !== undefined ? { workspaceId: result.workspaceId } : {}),
                  ...(result.computerId !== undefined ? { computerId: result.computerId } : {}),
                  ...(result.images !== undefined ? { images: result.images } : {}),
                });
                if (!startResult.started) {
                  send(ws, {
                    type: "chat.error",
                    conversationId: resolvedId,
                    message: "a turn is already generating for this conversation",
                  });
                } else {
                  logger.info?.("transport-ws: chat.send accepted", {
                    conversationId: resolvedId,
                    model: result.model ?? null,
                  });
                }
                break;
              }

              case "chat-subscribe": {
                ensureChatSubscribed(ws, state, result.conversationId);
                break;
              }

              case "chat-unsubscribe": {
                const dispose = state.chatSubscriptions.get(result.conversationId);
                if (dispose) {
                  dispose();
                  state.chatSubscriptions.delete(result.conversationId);
                }
                break;
              }

              case "chat-queue": {
                // Fire-and-forget: success is confirmed by the message-queue
                // SURFACE updating (startedTurn:false) or by streaming
                // chat.deltas (startedTurn:true), NOT by a reply here. On
                // startedTurn:true the sender is auto-subscribed so the new
                // turn's events stream to it (same as chat.send); on
                // startedTurn:false (queued for steering) we emit NOTHING
                // back and do not auto-subscribe.
                const enqueueResult = orchestrator.enqueue({
                  conversationId: result.conversationId,
                  text: result.text,
                  ...(result.workspaceId !== undefined ? { workspaceId: result.workspaceId } : {}),
                });
                if (enqueueResult.startedTurn) {
                  ensureChatSubscribed(ws, state, result.conversationId);
                }
                logger.info?.("transport-ws: chat.queue accepted", {
                  conversationId: result.conversationId,
                  startedTurn: enqueueResult.startedTurn,
                });
                break;
              }

              case "chat-queue-cancel": {
                // Fire-and-forget: success is confirmed by the message-queue
                // SURFACE updating (the cancelled message leaves the snapshot),
                // NOT by a reply here. Cancelling a message that is no longer
                // queued is a silent no-op (no surface update, no error).
                const cancelResult = orchestrator.cancelQueuedMessage({
                  conversationId: result.conversationId,
                  messageId: result.messageId,
                });
                logger.info?.("transport-ws: chat.queue.cancel accepted", {
                  conversationId: result.conversationId,
                  messageId: result.messageId,
                  cancelled: cancelResult.cancelled,
                });
                break;
              }

              case "chat-error": {
                logger.warn?.("transport-ws: malformed chat.send", {
                  reason: result.errorMessage,
                  ...(result.conversationId !== undefined
                    ? { conversationId: result.conversationId }
                    : {}),
                });
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
            connections.delete(ws);
            const state = ws.data;
            if (state) {
              // Dispose all chat subscriptions (does NOT abort turns).
              for (const dispose of state.chatSubscriptions.values()) {
                dispose();
              }
              state.chatSubscriptions.clear();
              // Dispose surface provider subscriptions.
              for (const dispose of state.providerDisposers.values()) {
                dispose();
              }
            }
            logger.debug("transport-ws: connection close");
          },
        },
      });

      logger.info?.("transport-ws: surface WebSocket listening", { port });
    },

    deactivate() {
      for (const dispose of disposers) {
        dispose();
      }
      disposers.length = 0;
      connections.clear();
      if (server) {
        server.stop();
        server = undefined;
      }
    },
  };
}
