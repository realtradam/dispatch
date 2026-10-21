/**
 * Shell — thin imperative layer that owns the Bun.serve WebSocket server.
 *
 * All decision logic lives in router.ts (pure, unit-tested).
 * This file handles I/O only: WS accept, JSON parse/stringify,
 * provider.subscribe wiring, orchestrator turn-streaming, server lifecycle.
 */

import { tileLayoutChanged } from "@dispatch/home-tile-layout-contract";
import type { Extension, HostAPI, Logger } from "@dispatch/kernel";
import { layoutChanged } from "@dispatch/layout-provider-contract";
import {
  buildAllowedHosts,
  checkHost,
  checkOrigin,
  type NetworkPolicyConfig,
  type NetworkPolicySnapshot,
} from "@dispatch/network-policy";
import { extensionsChanged } from "@dispatch/plugin-manager";
import type { SessionOrchestrator } from "@dispatch/session-orchestrator";
import {
  conversationCompacted,
  conversationOpened,
  conversationStatusChanged,
  conversationTabGroupChanged,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import type { SurfaceContext, SurfaceProvider, SurfaceRegistry } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { WsClientMessage, WsServerMessage } from "@dispatch/transport-contract";
import {
  usablePluginsInWorkspace,
  workspacePluginConfigHandle,
} from "@dispatch/workspace-plugin-config";
import { manifest } from "./manifest.js";
import { catalogMessageFiltered, routeClientMessage, subKey } from "./router.js";
import { jsonByteBound, serializeWithinBudget } from "./serialization.js";

/** Active provider subscriptions + chat subscription disposers for a single WS connection. */
interface ConnectionState {
  readonly connectionId?: string;
  closed?: boolean;
  readonly subs: Set<string>;
  readonly providerDisposers: Map<string, () => void>;
  /** Per-conversation chat subscription disposers (orchestrator.subscribe). */
  readonly chatSubscriptions: Map<string, () => void>;
  /**
   * THIS connection's active workspace, declared by the client via
   * `workspace.set` (plan 06 §6.4). `undefined` (never declared) → the
   * unfiltered global catalog — backward compatible.
   */
  workspaceId: string | undefined;
}

type Ws = Bun.ServerWebSocket<ConnectionState>;

/** Transport-owned reconciliation; timers/binds are injectable outer edges. */
export function startListeners<T extends { stop(closeActive?: boolean): unknown }>(
  addresses: readonly string[],
  tailscaleIps: readonly string[],
  bind: (address: string) => T,
  logger: Pick<Logger, "warn">,
  schedule: (callback: () => void, delayMs: number) => () => void = (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    return () => clearInterval(timer);
  },
) {
  const active = new Map<string, T>();
  const retries = new Map<string, () => void>();
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const cancel of retries.values()) cancel();
    retries.clear();
    for (const server of active.values()) server.stop(true);
    active.clear();
  };
  const update = (next: Pick<NetworkPolicySnapshot, "bindAddresses" | "tailscaleIps">) => {
    if (stopped) return;
    const desired = new Set(next.bindAddresses);
    // Withdraw listeners and their active clients, not just future accepts.
    for (const [address, cancel] of retries) {
      if (!desired.has(address)) {
        cancel();
        retries.delete(address);
      }
    }
    for (const [address, server] of active) {
      if (!desired.has(address)) {
        server.stop(true);
        active.delete(address);
      }
    }
    for (const address of desired) {
      if (active.has(address) || retries.has(address)) continue;
      try {
        active.set(address, bind(address));
      } catch (error) {
        if (!next.tailscaleIps.includes(address)) throw error;
        logger.warn("Tailscale bind failed; retrying every 10s", { address });
        const cancel = schedule(() => {
          if (stopped || retries.get(address) !== cancel) return;
          try {
            active.set(address, bind(address));
            retries.get(address)?.();
            retries.delete(address);
          } catch {
            // Remains unavailable; keep the same bounded retry timer.
          }
        }, 10_000);
        retries.set(address, cancel);
      }
    }
  };
  try {
    update({ bindAddresses: addresses, tailscaleIps });
  } catch (error) {
    stop();
    throw error;
  }
  return {
    get servers() {
      return [...active.values()];
    },
    update,
    stop,
  };
}

/** The HTTP handshake is guarded before any upgrade or connection state allocation. */
export function guardUpgrade(req: Request, allowed: ReadonlySet<string>): Response | undefined {
  const host = checkHost(req.headers.get("host") ?? new URL(req.url).host, allowed);
  if (host !== "ok") return Response.json({ error: host.reason }, { status: host.status });
  const origin = checkOrigin(req.headers.get("origin"), allowed);
  if (origin !== "ok") return Response.json({ error: origin.reason }, { status: origin.status });
  return undefined;
}

export function createTransportWsExtension(): Extension {
  let listeners:
    | ReturnType<typeof startListeners<ReturnType<typeof Bun.serve<ConnectionState>>>>
    | undefined;
  /** Every currently-connected WS client — used for global fan-out broadcasts. */
  const connections = new Set<Ws>();
  /** Disposers for host hook subscriptions (drained on deactivate). */
  const disposers: Array<() => void> = [];
  let connectionLogger: Logger | undefined;
  const watchdogs = new Map<
    Ws,
    {
      timer: ReturnType<typeof setInterval>;
      sentBytes: number;
    }
  >();

  function disposeConnection(ws: Ws): void {
    connections.delete(ws);
    const watchdog = watchdogs.get(ws);
    if (watchdog !== undefined) clearInterval(watchdog.timer);
    watchdogs.delete(ws);
    const state = ws.data;
    state.closed = true;
    const subscriptions = [
      ...state.chatSubscriptions.values(),
      ...state.providerDisposers.values(),
    ];
    state.chatSubscriptions.clear();
    state.providerDisposers.clear();
    state.subs.clear();
    for (const dispose of subscriptions) {
      try {
        dispose();
      } catch (err) {
        connectionLogger?.warn("transport-ws: subscription disposal failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return {
    manifest,
    async activate(host: HostAPI) {
      const registry: SurfaceRegistry = host.getService(surfaceRegistryHandle);
      const orchestrator: SessionOrchestrator = host.getService(sessionOrchestratorHandle);
      const logger = host.logger;
      connectionLogger = logger;
      const port = host.config.get<number>("surfaceWsPort") ?? 24205;

      function send(ws: Ws, msg: WsServerMessage): void {
        if (ws.data.closed) return;
        try {
          const closeIfBackpressured = () => {
            const bufferedBytes = ws.getBufferedAmount();
            if (bufferedBytes <= 8 * 1024 * 1024) return false;
            logger.warn("transport-ws: closing slow consumer", { bufferedBytes });
            disposeConnection(ws);
            ws.close(1013, "Slow consumer; reconnect and resync");
            return true;
          };
          if (closeIfBackpressured()) return;
          // A single unbounded tool payload must not create an unbounded socket
          // copy or close/replay loop. Full data stays in HTTP history.
          // 4 MiB allows routine MiB-scale tool inputs/results while a single
          // frame still uses at most half the 8 MiB slow-consumer budget.
          const frameBudget = msg.type === "chat.delta" ? 4 * 1024 * 1024 : 1024 * 1024;
          const serialized = serializeWithinBudget(msg, frameBudget);
          if (serialized === undefined) {
            if (msg.type === "chat.delta") {
              send(ws, {
                type: "chat.resync-required",
                conversationId: msg.event.conversationId,
                ...("turnId" in msg.event ? { turnId: msg.event.turnId } : {}),
                reason: "payload-limit",
              });
            } else {
              logger.warn("transport-ws: oversized non-chat message omitted", { type: msg.type });
              send(ws, {
                type: "error",
                message: "WebSocket payload exceeds delivery limit",
              });
            }
            return;
          }
          ws.send(serialized);
          const existingWatchdog = watchdogs.get(ws);
          if (existingWatchdog) existingWatchdog.sentBytes += Buffer.byteLength(serialized);
          if (closeIfBackpressured()) return;
          // Even an idle consumer stuck below 8 MiB must eventually be disposed.
          // Only lack of progress times out; a slowly draining socket survives.
          if (ws.getBufferedAmount() > 0 && !watchdogs.has(ws)) {
            let previous = ws.getBufferedAmount();
            let lastProgress = Date.now();
            const watchdog = {
              sentBytes: 0,
              timer: setInterval(() => {
                const bufferedBytes = ws.getBufferedAmount();
                if (bufferedBytes === 0 || ws.data.closed) {
                  clearInterval(watchdog.timer);
                  watchdogs.delete(ws);
                  return;
                }
                // Account for new writes: a stable backlog under continuous
                // traffic is progress, not a stuck socket.
                if (bufferedBytes < previous + watchdog.sentBytes) lastProgress = Date.now();
                previous = bufferedBytes;
                watchdog.sentBytes = 0;
                if (Date.now() - lastProgress >= 30_000) {
                  logger.warn("transport-ws: closing stalled consumer", { bufferedBytes });
                  disposeConnection(ws);
                  ws.close(1013, "Stalled consumer; reconnect and resync");
                }
              }, 5_000),
            };
            watchdogs.set(ws, watchdog);
          }
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
       * The catalog message for ONE connection (plan 06 §6.4): unfiltered
       * (global) when the connection declared no workspace or the
       * workspace-plugin-config service is absent (degrade open);
       * otherwise filtered to the surfaces whose contributing plugins are
       * usable in the connection's workspace (via the shared
       * `usablePluginsInWorkspace` rule + `SurfaceCatalogEntry.pluginId`).
       */
      async function catalogForConnection(state: ConnectionState) {
        if (state.workspaceId === undefined) {
          return catalogMessageFiltered(registry, undefined);
        }
        const config = host.tryGetService(workspacePluginConfigHandle);
        if (config === undefined) {
          return catalogMessageFiltered(registry, undefined); // degrade open
        }
        const manifests = host.getExtensions();
        const tierOf = (pluginId: string) => manifests.find((m) => m.id === pluginId)?.tier;
        const contributed = [
          ...new Set(
            registry
              .getCatalog()
              .map((entry) => entry.pluginId)
              .filter((id): id is string => id !== undefined),
          ),
        ];
        const usable = await usablePluginsInWorkspace(
          state.workspaceId,
          contributed,
          config,
          tierOf,
        );
        return catalogMessageFiltered(registry, usable);
      }

      /** Re-push every connection's workspace-filtered catalog (§6.4). */
      async function repushCatalogs(): Promise<void> {
        for (const ws of connections) {
          send(ws, await catalogForConnection(ws.data));
        }
      }

      /**
       * Ensure this connection is subscribed to a conversation's chat events.
       * Idempotent — no-op if already subscribed. The orchestrator replays
       * buffered events to new subscribers (late-join), then streams live.
       */
      function ensureChatSubscribed(ws: Ws, state: ConnectionState, conversationId: string): void {
        if (state.closed || state.chatSubscriptions.has(conversationId)) {
          return;
        }
        // All-or-nothing preflight avoids both partial provisional transcripts
        // and oversized replay bursts. Allow ordinary multi-MiB turns in full:
        // at most 4 MiB per replay and 6 MiB shared socket backlog, leaving 2 MiB
        // headroom below the 8 MiB close bound. No serialized replay queue is
        // retained; reference snapshots are bounded by actual envelope bytes.
        if (state.chatSubscriptions.size + state.subs.size >= 256) {
          logger.warn("transport-ws: chat subscription rejected", {
            connectionId: state.connectionId ?? null,
            conversationId,
            chatSubscriptions: state.chatSubscriptions.size,
            surfaceSubscriptions: state.subs.size,
          });
          send(ws, {
            type: "chat.subscription-rejected",
            conversationId,
            reason: "subscription-limit",
          });
          return;
        }
        let budget = Math.min(
          4 * 1024 * 1024,
          Math.max(0, 6 * 1024 * 1024 - ws.getBufferedAmount()),
        );
        const unsubscribe = orchestrator.subscribe(
          conversationId,
          (event) => send(ws, { type: "chat.delta", event }),
          {
            replay: {
              maxEvents: Number.MAX_SAFE_INTEGER,
              accept(event) {
                const bytes = jsonByteBound({ type: "chat.delta", event }, budget);
                if (bytes === undefined) return false;
                budget -= bytes;
                return true;
              },
              onOmitted(turnId) {
                send(ws, {
                  type: "chat.resync-required",
                  conversationId,
                  turnId,
                  reason: "replay-limit",
                });
              },
            },
          },
        );
        if (state.closed) unsubscribe();
        else state.chatSubscriptions.set(conversationId, unsubscribe);
      }

      function subscribeToProvider(
        ws: Ws,
        provider: SurfaceProvider,
        surfaceId: string,
        conversationId: string | undefined,
        state: ConnectionState,
      ): void {
        const key = subKey(surfaceId, conversationId);
        if (state.closed || !provider.subscribe || state.providerDisposers.has(key)) {
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
        if (state.closed) dispose();
        else state.providerDisposers.set(key, dispose);
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
        host.on(conversationOpened, ({ conversationId, workspaceId, model, tabGroupParentId }) => {
          broadcast({
            type: "conversation.open",
            conversationId,
            workspaceId,
            ...(model !== undefined ? { model } : {}),
            ...(tabGroupParentId !== undefined ? { tabGroupParentId } : {}),
          });
        }),
      );

      disposers.push(
        host.on(conversationTabGroupChanged, (payload) => {
          broadcast({ type: "conversation.tabGroupChanged", ...payload });
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
          ({
            conversationId,
            newConversationId,
            messagesSummarized,
            messagesKept,
            historyEpoch,
          }) => {
            broadcast({
              type: "conversation.compacted",
              historyEpoch,
              conversationId,
              newConversationId,
              messagesSummarized,
              messagesKept,
            });
          },
        ),
      );

      // Broadcast `extensions-changed` to ALL connected clients after every
      // plugin-manager mutation (load / unload / reload / scan / forget) so
      // every connected frontend refetches the extension list AND the
      // surface catalog (§11 multi-client coherence). The hook payload IS
      // the wire message — forwarded verbatim. The catalog itself is ALSO
      // re-pushed per connection, workspace-filtered (plan 06 §6.4): a
      // load/unload changes which surfaces exist, so every workspace view
      // must refresh even if the client never re-sends `workspace.set`.
      disposers.push(
        host.on(extensionsChanged, (message) => {
          broadcast(message);
          void repushCatalogs().catch(() => {
            // Catalog re-push is best-effort — a failed config read must
            // never break the extensions-changed fan-out.
          });
        }),
      );

      // Broadcast `layout` to ALL connected clients after every successful
      // layout write (plan 02 §2.5 — the layout-chat provider's PUT /
      // setTree / DELETE / ops). Pure verbatim ferrying of a TYPED wire
      // message, exactly like `extensions-changed`: the transport learns
      // nothing about trees (D-L6) — clients filter by their active
      // workspace (the workspaceId rides the payload; decision 7 full-tree).
      disposers.push(
        host.on(layoutChanged, (message) => {
          broadcast(message);
        }),
      );

      // Broadcast `tile-layout` to ALL connected clients after every
      // successful home tile-layout write (the `home-tile-layout` plugin's
      // PUT / DELETE). Pure verbatim ferrying of a TYPED wire message,
      // exactly like `layout`: the transport learns nothing about tile
      // documents (D-L6) — clients filter by their active geometry mode
      // (the orientation rides the payload; full-document, no patch
      // protocol).
      disposers.push(
        host.on(tileLayoutChanged, (message) => {
          broadcast(message);
        }),
      );

      const policy = host.config.get<NetworkPolicyConfig>("networkPolicy") ?? {
        allowedHosts: buildAllowedHosts({ env: {} }),
        bindAddresses: ["127.0.0.1", "::1"],
        tailscaleIps: [],
      };
      // Stable request-policy view: guards/CORS see the latest complete publication.
      const allowedHosts = new Set(policy.allowedHosts);
      const options: Bun.ServeOptions<ConnectionState> = {
        port,
        fetch(req, srv) {
          const denied = guardUpgrade(req, allowedHosts);
          if (denied) {
            logger.warn("transport-ws: rejected request", {
              host: req.headers.get("host"),
              origin: req.headers.get("origin"),
              status: denied.status,
            });
            return denied;
          }
          if (new URL(req.url).pathname === "/health") return Response.json({ ok: true });
          const initial: ConnectionState = {
            connectionId: crypto.randomUUID(),
            subs: new Set(),
            providerDisposers: new Map(),
            chatSubscriptions: new Map(),
            workspaceId: undefined,
          };
          if (srv.upgrade(req, { data: initial })) return;
          return new Response("expected websocket", { status: 426 });
        },
        websocket: {
          open(ws) {
            connections.add(ws);
            logger.debug("transport-ws: connection open", {
              connectionId: ws.data.connectionId ?? null,
            });
            // Initial catalog push (plan 06 §6.4): a connection that has not
            // declared a workspace (none can have yet) gets the unfiltered
            // global catalog — backward compatible.
            void catalogForConnection(ws.data).then((msg) => send(ws, msg));
          },

          async message(ws, message) {
            const state = ws.data;
            if (!state || state.closed) return;

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
                    if (
                      !state.subs.has(key) &&
                      state.chatSubscriptions.size + state.subs.size >= 256
                    ) {
                      logger.warn("transport-ws: surface subscription rejected", {
                        connectionId: state.connectionId ?? null,
                        surfaceId: result.subChange.surfaceId,
                        chatSubscriptions: state.chatSubscriptions.size,
                        surfaceSubscriptions: state.subs.size,
                      });
                      send(ws, {
                        type: "error",
                        surfaceId: result.subChange.surfaceId,
                        message: "Too many subscriptions",
                      });
                      return;
                    }
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
                  onAdmission(admission) {
                    if (admission.accepted)
                      logger.info("transport-ws: chat.send durably accepted", {
                        conversationId: resolvedId,
                        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                      });
                    if (result.requestId === undefined) return;
                    send(
                      ws,
                      admission.accepted
                        ? {
                            type: "chat.accepted",
                            conversationId: resolvedId,
                            requestId: result.requestId,
                          }
                        : {
                            type: "chat.error",
                            conversationId: resolvedId,
                            requestId: result.requestId,
                            message: admission.message,
                          },
                    );
                  },
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
                if (!startResult.started && startResult.reason === "queued-behind-compaction") {
                  try {
                    const admission = await startResult.admission;
                    if (admission.messageId !== undefined) {
                      logger.info?.("transport-ws: chat.send queued behind compaction", {
                        conversationId: resolvedId,
                        messageId: admission.messageId,
                      });
                      send(ws, {
                        type: "chat.queued",
                        conversationId: resolvedId,
                        reason: "compaction",
                        messageId: admission.messageId,
                        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                      });
                    } else if (!admission.startedTurn) {
                      send(ws, {
                        type: "chat.error",
                        conversationId: resolvedId,
                        message: "input cancelled before queue admission",
                        ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                      });
                    }
                  } catch (error) {
                    send(ws, {
                      type: "chat.error",
                      conversationId: resolvedId,
                      message: error instanceof Error ? error.message : String(error),
                      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                    });
                  }
                } else if (!startResult.started) {
                  send(ws, {
                    type: "chat.error",
                    conversationId: resolvedId,
                    message: "a turn is already generating for this conversation",
                    ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                  });
                } else {
                  logger.info?.("transport-ws: chat.send started; awaiting admission", {
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
                const enqueueResult = await orchestrator
                  .enqueue({
                    ...(result.requestId === undefined
                      ? {}
                      : {
                          onAdmission(
                            admission: { accepted: true } | { accepted: false; message: string },
                          ) {
                            if (result.requestId === undefined) return;
                            send(
                              ws,
                              admission.accepted
                                ? {
                                    type: "chat.accepted",
                                    conversationId: result.conversationId,
                                    requestId: result.requestId,
                                  }
                                : {
                                    type: "chat.error",
                                    conversationId: result.conversationId,
                                    requestId: result.requestId,
                                    message: admission.message,
                                  },
                            );
                          },
                        }),
                    conversationId: result.conversationId,
                    text: result.text,
                    ...(result.images !== undefined ? { images: result.images } : {}),
                    ...(result.computerId !== undefined ? { computerId: result.computerId } : {}),
                    ...(result.workspaceId !== undefined
                      ? { workspaceId: result.workspaceId }
                      : {}),
                  })
                  .catch((error: unknown) => {
                    logger.warn("transport-ws: queue storage failed", {
                      conversationId: result.conversationId,
                    });
                    send(ws, {
                      type: "chat.error",
                      conversationId: result.conversationId,
                      message: error instanceof Error ? error.message : String(error),
                      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
                    });
                    return undefined;
                  });
                if (enqueueResult === undefined) break;
                if (enqueueResult.startedTurn) {
                  ensureChatSubscribed(ws, state, result.conversationId);
                } else if (result.requestId !== undefined) {
                  send(
                    ws,
                    enqueueResult.messageId !== undefined
                      ? {
                          type: "chat.accepted",
                          conversationId: result.conversationId,
                          requestId: result.requestId,
                        }
                      : {
                          type: "chat.error",
                          conversationId: result.conversationId,
                          requestId: result.requestId,
                          message: "Input was not admitted to the queue",
                        },
                  );
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
                  ...((parsed.type === "chat.send" || parsed.type === "chat.queue") &&
                  typeof parsed.requestId === "string"
                    ? { requestId: parsed.requestId }
                    : {}),
                });
                break;
              }

              case "workspace-set": {
                // Record THIS connection's active workspace (plan 06 §6.4)
                // and RE-PUSH the catalog filtered to it — workspace
                // switching is instant + client-side, so the server must be
                // told explicitly.
                state.workspaceId = result.workspaceId;
                logger.info?.("transport-ws: workspace.set", {
                  workspaceId: result.workspaceId,
                });
                void catalogForConnection(state).then((msg) => send(ws, msg));
                break;
              }

              case "workspace-error": {
                // Malformed workspace.set: log + send NOTHING (no
                // workspace-scoped error message type); the connection keeps
                // its previous workspace.
                logger.warn?.("transport-ws: malformed workspace.set", {
                  reason: result.errorMessage,
                });
                break;
              }
            }
          },

          close(ws, code, reason) {
            disposeConnection(ws);
            logger.debug("transport-ws: connection close", {
              connectionId: ws.data.connectionId ?? null,
              code,
              reason,
            });
          },
        },
      };
      try {
        listeners = startListeners(
          policy.bindAddresses,
          policy.tailscaleIps,
          (hostname) => Bun.serve<ConnectionState>({ ...options, hostname }),
          logger,
        );
        const unsubscribe = policy.subscribe?.((next) => {
          allowedHosts.clear();
          for (const host of next.allowedHosts) allowedHosts.add(host);
          listeners?.update(next);
        });
        if (unsubscribe) disposers.push(unsubscribe);
      } catch (error) {
        listeners?.stop();
        listeners = undefined;
        for (const dispose of disposers) dispose();
        disposers.length = 0;
        throw error;
      }

      logger.info?.("transport-ws: surface WebSocket listening", { port });
    },

    deactivate() {
      for (const dispose of disposers) {
        dispose();
      }
      disposers.length = 0;
      for (const ws of connections) disposeConnection(ws);
      listeners?.stop();
      listeners = undefined;
    },
  };
}
