/**
 * message-queue extension — owns the per-conversation steering message queue
 * (state + surface + drain-and-clear). Plugs into the kernel host via a
 * manifest + activate(host); the session-orchestrator drains it via the
 * `messageQueueHandle` service. Does NOT touch the turn loop.
 */
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { SurfaceContext, SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { SurfaceSpec } from "@dispatch/ui-contract";
import { buildQueueSpec, MESSAGE_QUEUE_SURFACE_ID } from "./pure.js";
import { createMessageQueueService, messageQueueHandle } from "./service.js";

export const manifest: Manifest = {
  id: "message-queue",
  name: "Message Queue",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  dependsOn: ["surface-registry"],
  capabilities: {},
  contributes: {
    services: ["message-queue"],
  },
};

export function activate(host: HostAPI): void {
  const registry = host.getService(surfaceRegistryHandle);

  const subscribers = new Set<() => void>();

  const service = createMessageQueueService({
    id: () => crypto.randomUUID(),
    now: () => Date.now(),
    notify: () => {
      for (const sub of subscribers) {
        sub();
      }
    },
    logger: host.logger,
  });

  host.provideService(messageQueueHandle, service);

  function getSpec(context?: SurfaceContext): SurfaceSpec {
    const convId = context?.conversationId;
    const messages = convId === undefined ? [] : service.getQueue(convId);
    return buildQueueSpec(messages);
  }

  function invoke(_actionId: string, _payload?: unknown, _context?: SurfaceContext): void {
    // The message-queue surface is read-only: a client renders the queue and
    // the session-orchestrator drains it. No client-facing actions.
  }

  const provider: SurfaceProvider = {
    catalogEntry: {
      id: MESSAGE_QUEUE_SURFACE_ID,
      region: "side",
      title: "Message Queue",
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

  host.logger.info("message-queue: registered");
}

export const extension: Extension = {
  manifest,
  activate,
};
