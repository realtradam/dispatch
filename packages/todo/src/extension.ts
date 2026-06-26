/**
 * todo extension — owns the per-conversation task list (state + surface + the
 * `todo_write` tool). Plugs into the kernel host via a manifest +
 * `activate(host)`; the model maintains the list via the tool, and the surface
 * renders the live list for the frontend (subscriber-notify, same pattern as
 * message-queue). State is in-memory (per-process, per-conversation) — no
 * persistence, mirroring message-queue.
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { SurfaceContext, SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";
import type { SurfaceSpec } from "@dispatch/ui-contract";
import { buildTodoSpec, getTodos, TODO_SURFACE_ID, type TodoState } from "./pure.js";
import { createTodoWriteTool } from "./tool.js";

export const manifest: Manifest = {
  id: "todo",
  name: "Todo Tool",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  dependsOn: ["surface-registry"],
  capabilities: {},
  contributes: {
    tools: ["todo_write"],
  },
};

export function activate(host: HostAPI): void {
  const registry = host.getService(surfaceRegistryHandle);

  const state: TodoState = new Map();
  const subscribers = new Set<() => void>();

  function notify(): void {
    for (const sub of subscribers) {
      sub();
    }
  }

  host.defineTool(createTodoWriteTool({ state, notify }));

  function getSpec(context?: SurfaceContext): SurfaceSpec {
    const convId = context?.conversationId;
    const todos = convId === undefined ? [] : getTodos(state, convId);
    return buildTodoSpec(todos);
  }

  function invoke(_actionId: string, _payload?: unknown, _context?: SurfaceContext): void {
    // The todo surface is read-only: the model mutates the list via the
    // `todo_write` tool; no client-facing surface actions.
  }

  const provider: SurfaceProvider = {
    catalogEntry: {
      id: TODO_SURFACE_ID,
      region: "side",
      title: "Tasks",
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

  host.logger.info("todo: registered");
}

export const extension: Extension = {
  manifest,
  activate,
};
