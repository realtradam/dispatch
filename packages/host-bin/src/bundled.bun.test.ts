import {
  assertNoCoreToStandardDeps,
  findCoreToStandardDeps,
  resolveActivationOrder,
} from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { createBundledExtensions } from "./bundled.js";

/** The bundled set with an empty credential list (assembly detail of boot). */
function bundled() {
  return createBundledExtensions({ credentials: [] });
}

/** Manifest ids in DAG-resolved activation order. */
function activationOrder() {
  return resolveActivationOrder(bundled().map((e) => e.manifest)).map((m) => m.id);
}

describe("bundled extension set (de-curated, plan 02)", () => {
  it("resolves to a full activation order with no unmet deps and no cycles", () => {
    // De-curation guarantee: main.ts no longer orders extensions by hand, so
    // the manifests' dependsOn edges ALONE must produce a valid order. This
    // throws if any dependsOn target is missing from the set or a cycle exists.
    expect(activationOrder().length).toBe(bundled().length);
  });

  it("activates dependencies before dependents (the old hand-written ordering comments)", () => {
    const order = activationOrder();
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    // exec-backend provides the resolver the file tools resolve through.
    before("exec-backend", "tool-read-file");
    before("exec-backend", "tool-edit-file");
    before("exec-backend", "tool-write-file");
    before("exec-backend", "tool-shell");
    // session-orchestrator + conversation-store + credential-store are
    // resolved at activate time by agent-management and vision-handoff.
    before("session-orchestrator", "agent-management");
    before("conversation-store", "agent-management");
    before("named-agents", "agent-management");
    before("credential-store", "agent-management");
    before("credential-store", "vision-handoff");
    // surface-registry before its consumers.
    before("surface-registry", "transport-ws");
    before("surface-registry", "message-queue");
    before("surface-registry", "surface-loaded-extensions");
  });

  it("classifies the plan-02 reclassification: credential-store is core, providers are providers", () => {
    const tierById = new Map(bundled().map((e) => [e.manifest.id, e.manifest.tier]));
    expect(tierById.get("credential-store")).toBe("core");
    expect(tierById.get("provider-umans")).toBe("providers");
    expect(tierById.get("provider-longcat")).toBe("providers");
    expect(tierById.get("provider-hyper")).toBe("providers");
    expect(tierById.get("provider-openrouter")).toBe("providers");
    expect(tierById.get("provider-openai-compat")).toBe("providers");
  });

  // Plan-08 pilot (§12): lsp is BACK in the bundled set as a standard plugin,
  // inert until a workspace opts in (blank per-workspace default).
  it("bundles lsp as tier standard (the plan-08 mechanism pilot)", () => {
    const lsp = bundled().find((e) => e.manifest.id === "lsp");
    expect(lsp).toBeDefined();
    expect(lsp?.manifest.tier).toBe("standard");
    expect(lsp?.manifest.contributes?.tools).toContain("lsp");
  });

  // CANARY FLIPPED (plan 03): the former transport-http core→standard edges
  // (heartbeat, mcp, named-agents, throughput-store) are gone — those
  // Standard services are consumed reactively via the kernel's service
  // registry (tryGetService + availability subscriptions), never via a
  // dependsOn edge. The constitutional rule ("core depends only on core")
  // is now enforced on the bundled set by mechanism.
  it("has NO core→standard edges (the constitutional rule, enforced since plan 03)", () => {
    const manifests = bundled().map((e) => e.manifest);
    expect(findCoreToStandardDeps(manifests)).toEqual([]);
    expect(() => assertNoCoreToStandardDeps(manifests)).not.toThrow();
  });

  it("transport-http depends only on core extensions (reactive consumption of Standard services)", () => {
    const tierById = new Map(bundled().map((e) => [e.manifest.id, e.manifest.tier]));
    const transportHttp = bundled().find((e) => e.manifest.id === "transport-http");
    expect(transportHttp).toBeDefined();
    for (const dep of transportHttp?.manifest.dependsOn ?? []) {
      expect(tierById.get(dep)).toBe("core");
    }
  });
});
