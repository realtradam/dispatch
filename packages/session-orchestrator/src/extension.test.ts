import { type ConversationStore, conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Bus, HostAPI, Logger } from "@dispatch/kernel";
import { createBus } from "@dispatch/kernel";
import { type MessageQueueService, messageQueueHandle } from "@dispatch/message-queue";
import { concurrencyServiceHandle } from "@dispatch/provider-concurrency";
import { systemPromptHandle } from "@dispatch/system-prompt";
import { describe, expect, it } from "vitest";
import { activate } from "./extension.js";
import {
  cacheWarmHandle,
  compactionHandle,
  type SessionOrchestrator,
  sessionOrchestratorHandle,
  visionHandoffLocalHandle,
} from "./orchestrator.js";

// ── Injected fakes (effects, not mocks of our own modules) ─────────────────

function fakeLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return fakeLogger();
    },
    span() {
      const span: ReturnType<Logger["span"]> = {
        id: "fake-span",
        log: fakeLogger(),
        setAttributes() {},
        addLink() {},
        child() {
          return span;
        },
        end() {},
      };
      return span;
    },
  };
}

/**
 * A conversation-store stand-in for the paths this test drives (queue
 * degradation only — no store method is ever invoked). Every property
 * resolves to a promise-returning no-op so an accidental call can't throw.
 */
function unusedConversationStore(): ConversationStore {
  return new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as ConversationStore;
}

/**
 * A HostAPI whose service operations are the REAL kernel bus — so the
 * extension's `tryGetService` resolvers see provides / un-provides exactly
 * as they would in the live host. The mandatory core deps (conversation
 * store, credential store) are seeded into the bus; everything activate()
 * doesn't touch is a no-op stub.
 */
function createBusHostAPI(): HostAPI & {
  readonly bus: Bus;
  readonly provided: Map<string, unknown>;
} {
  const logger = fakeLogger();
  const bus = createBus(logger);
  const provided = new Map<string, unknown>();
  // Mandatory core services, seeded at bus level (the real extensions
  // provide them before session-orchestrator activates).
  bus.provideService(conversationStoreHandle, unusedConversationStore());
  bus.provideService(credentialStoreHandle, {
    resolve: () => undefined,
    getModelInfo: async () => undefined,
  });
  return {
    bus,
    provided,
    getService: (handle) => bus.getService(handle),
    tryGetService: (handle) => bus.tryGetService(handle),
    provideService: (handle, impl) => {
      provided.set(handle.id, impl);
      return bus.provideService(handle, impl);
    },
    onServiceAvailable: (handle, cb) => bus.onServiceAvailable(handle, cb),
    onServiceUnavailable: (handle, cb) => bus.onServiceUnavailable(handle, cb),
    getProviders: () => new Map(),
    getTools: () => new Map(),
    getAuthProviders: () => new Map(),
    getExtensions: () => [],
    addFilter: () => () => {},
    applyFilters: async (_hook, value) => value,
    emit: () => {},
    logger,
  } as unknown as HostAPI & { readonly bus: Bus; readonly provided: Map<string, unknown> };
}

/** A steering-queue stand-in with an inspectable per-conversation queue. */
function fakeQueue(initial: Array<{ id: string; text: string }>): MessageQueueService {
  let queue = initial;
  return {
    enqueue: (_conversationId, text) => {
      queue = [...queue, { id: `q${queue.length + 1}`, text }];
      return queue;
    },
    getQueue: () => queue,
    cancel: (_conversationId, messageId) => {
      queue = queue.filter((q) => q.id !== messageId);
      return queue;
    },
    drain: () => {
      const drained = queue;
      queue = [];
      return drained;
    },
  } as unknown as MessageQueueService;
}

// ── Reactive service consumption (plan 03) ─────────────────────────────────

describe("session-orchestrator extension (reactive service registry)", () => {
  it("activates with every optional service absent (no throw) and provides the core services", () => {
    const host = createBusHostAPI();
    expect(() => activate(host)).not.toThrow();
    // The extension's own core services are provided.
    expect(host.provided.has(sessionOrchestratorHandle.id)).toBe(true);
    expect(host.provided.has(cacheWarmHandle.id)).toBe(true);
    expect(host.provided.has(compactionHandle.id)).toBe(true);
  });

  it("queue operations degrade when message-queue is absent, serve when it is provided mid-session, and degrade again on un-provide", () => {
    const host = createBusHostAPI();
    activate(host);
    const orchestrator = host.provided.get(sessionOrchestratorHandle.id) as SessionOrchestrator;

    // Absent: nothing to cancel → degrade (no throw, empty snapshot).
    expect(orchestrator.cancelQueuedMessage({ conversationId: "c1", messageId: "m1" })).toEqual({
      cancelled: false,
      queue: [],
    });

    // Mid-session load: the SAME orchestrator instance resolves the queue per
    // call — no restart, no re-activation.
    const unprovide = host.provideService(
      messageQueueHandle,
      fakeQueue([{ id: "m1", text: "hi" }]),
    );
    expect(orchestrator.cancelQueuedMessage({ conversationId: "c1", messageId: "m1" })).toEqual({
      cancelled: true,
      queue: [],
    });

    // Mid-session un-load: the next call degrades again.
    unprovide();
    expect(orchestrator.cancelQueuedMessage({ conversationId: "c1", messageId: "m2" })).toEqual({
      cancelled: false,
      queue: [],
    });
  });

  it("optional Standard handles resolve to undefined until provided (resolvers are non-throwing)", () => {
    const host = createBusHostAPI();
    activate(host);
    // The registry (via the same non-throwing lookup the resolvers use) is
    // empty for every optional handle before any provide.
    expect(host.bus.tryGetService(messageQueueHandle)).toBeUndefined();
    expect(host.bus.tryGetService(visionHandoffLocalHandle)).toBeUndefined();
    expect(host.bus.tryGetService(concurrencyServiceHandle)).toBeUndefined();
    expect(host.bus.tryGetService(systemPromptHandle)).toBeUndefined();
    expect(host.bus.tryGetService(compactionHandle)).toBeDefined(); // core-provided at activate
  });
});
