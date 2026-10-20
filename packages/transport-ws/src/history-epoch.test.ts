import { createBus, type HostAPI, type Logger } from "@dispatch/kernel";
import {
  conversationCompacted,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
} from "@dispatch/session-orchestrator";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import { afterEach, expect, it, vi } from "vitest";
import { createTransportWsExtension } from "./extension.js";

afterEach(() => vi.unstubAllGlobals());

it("forwards the compaction hook epoch to every connection without starting a server", async () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
  const bus = createBus(logger);
  bus.provideService(surfaceRegistryHandle, {
    getCatalog: () => [],
    getSurface: () => undefined,
    register: () => () => {},
  });
  bus.provideService(sessionOrchestratorHandle, {} as SessionOrchestrator);
  let options: Bun.ServeOptions<unknown> | undefined;
  vi.stubGlobal("Bun", {
    serve: (opts: Bun.ServeOptions<unknown>) => {
      options = opts;
      return { stop() {} };
    },
  });
  const extension = createTransportWsExtension();
  const host = {
    logger,
    getService: bus.getService,
    tryGetService: bus.tryGetService,
    on: bus.on,
    config: {
      get: (key: string) =>
        key === "networkPolicy"
          ? { allowedHosts: new Set(["localhost"]), bindAddresses: ["127.0.0.1"], tailscaleIps: [] }
          : undefined,
    },
    getExtensions: () => [],
  } as unknown as HostAPI;
  try {
    await extension.activate(host);
    expect(options?.websocket?.open).toBeTypeOf("function");
    const sent: string[][] = [[], []];
    for (const messages of sent) {
      options?.websocket?.open?.({
        data: {},
        send: (message: string) => {
          messages.push(message);
        },
      } as unknown as Bun.ServerWebSocket<unknown>);
    }
    await Promise.resolve(); // initial catalogs
    for (const historyEpoch of [0, 7, 8]) {
      const payload = {
        conversationId: "c",
        newConversationId: "archive",
        messagesSummarized: 5,
        messagesKept: 2,
        historyEpoch,
      };
      bus.emit(conversationCompacted, payload);
      await vi.waitFor(() => {
        for (const messages of sent)
          expect(JSON.parse(messages.at(-1) ?? "null")).toEqual({
            type: "conversation.compacted",
            ...payload,
            historyEpoch,
          });
      });
    }
  } finally {
    await extension.deactivate?.();
  }
});
