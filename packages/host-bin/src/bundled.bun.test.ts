import { findCoreToStandardDeps, resolveActivationOrder } from "@dispatch/kernel";
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

  // CANARY (plan 03 removes these edges — update this test when it lands).
  // transport-http is core but still declares standard-tier dependsOn targets
  // — a core→standard violation the constitutional rule forbids. Plan 02
  // makes it VISIBLE (machine-checkable); plan 03 fixes it.
  it("flags the known core→standard edges on transport-http (canary until plan 03)", () => {
    const violations = findCoreToStandardDeps(bundled().map((e) => e.manifest));
    const edges = violations
      .filter((v) => v.id === "transport-http")
      .map((v) => v.depId)
      .sort();
    expect(edges).toEqual(["heartbeat", "mcp", "named-agents", "throughput-store"]);
  });

  it("has no core→standard edges OUTSIDE the known plan-03 debt", () => {
    const violations = findCoreToStandardDeps(bundled().map((e) => e.manifest));
    expect(violations.every((v) => v.id === "transport-http")).toBe(true);
  });
});
