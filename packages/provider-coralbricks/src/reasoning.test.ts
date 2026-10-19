import { describe, expect, it } from "vitest";
import { mapReasoningEffort, transformBody } from "./reasoning.js";

describe("mapReasoningEffort", () => {
  it("maps the Dispatch ladder onto CoralBricks' low/high/max ladder", () => {
    expect(mapReasoningEffort("low")).toBe("low");
    expect(mapReasoningEffort("medium")).toBe("high");
    expect(mapReasoningEffort("high")).toBe("high");
    expect(mapReasoningEffort("xhigh")).toBe("max");
    expect(mapReasoningEffort("max")).toBe("max");
  });

  it("maps undefined to undefined (no field)", () => {
    expect(mapReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("transformBody", () => {
  it("adds reasoning_effort when opts.reasoningEffort is set", () => {
    expect(transformBody({}, { reasoningEffort: "high" })).toEqual({ reasoning_effort: "high" });
  });

  it("maps medium to high and xhigh to max in the body", () => {
    expect(transformBody({}, { reasoningEffort: "medium" })).toEqual({ reasoning_effort: "high" });
    expect(transformBody({}, { reasoningEffort: "xhigh" })).toEqual({ reasoning_effort: "max" });
  });

  it("adds nothing when opts.reasoningEffort is absent (byte-stable)", () => {
    expect(transformBody({}, {})).toEqual({});
  });
});
