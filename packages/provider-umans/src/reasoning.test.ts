import { describe, expect, it } from "vitest";
import { mapReasoningEffort, transformBody } from "./reasoning.js";

describe("mapReasoningEffort", () => {
  it('mapReasoningEffort: low → "low", medium → "medium", high → "high", xhigh → "high", max → "high"', () => {
    expect(mapReasoningEffort("low")).toBe("low");
    expect(mapReasoningEffort("medium")).toBe("medium");
    expect(mapReasoningEffort("high")).toBe("high");
    expect(mapReasoningEffort("xhigh")).toBe("high");
    expect(mapReasoningEffort("max")).toBe("high");
  });

  it("mapReasoningEffort: undefined → undefined (no field)", () => {
    expect(mapReasoningEffort(undefined)).toBe(undefined);
  });
});

describe("transformBody", () => {
  it("transformBody adds reasoning_effort when opts.reasoningEffort is set", () => {
    const result = transformBody({}, { reasoningEffort: "high" });
    expect(result).toEqual({ reasoning_effort: "high" });
  });

  it("transformBody adds nothing when opts.reasoningEffort is absent (byte-stable)", () => {
    const result = transformBody({}, {});
    expect(result).toEqual({});
  });
});
