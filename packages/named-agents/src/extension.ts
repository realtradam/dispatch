/**
 * named-agents extension — manifest + activate(host).
 *
 * Wires the Named Agent registry against the `named-agents` storage namespace,
 * registers the typed service handle, and logs via `host.logger`. The registry
 * is self-contained: it owns no seeding, no provider-catalog calls, and no
 * secrets (a Named Agent record is a name + a canonical model identifier — both
 * user-visible config, neither redacted). An empty registry is a valid state.
 */
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createNamedAgentsService, namedAgentServiceHandle } from "./registry.js";

export const manifest: Manifest = {
  id: "named-agents",
  name: "Named Agents",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { db: true },
  contributes: { services: ["named-agents/service"] },
};

export function activate(host: HostAPI): void {
  const storage = host.storage("named-agents");
  const service = createNamedAgentsService(storage);
  host.provideService(namedAgentServiceHandle, service);
  host.logger.info("named-agents: registry activated");
}

export const extension: Extension = {
  manifest,
  activate,
};
