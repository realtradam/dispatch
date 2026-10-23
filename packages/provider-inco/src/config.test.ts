import { describe, expect, it } from "vitest";
import {
  INCO_BASE_URL,
  INCO_DEFAULT_MODEL,
  mapIncoReasoningEffort,
  resolveIncoConfig,
} from "./index.js";

it("resolves official defaults with the fast model and no ambient I/O", () => {
  expect(resolveIncoConfig({ apiKey: "fake" })).toEqual({
    apiKey: "fake",
    baseURL: INCO_BASE_URL,
    model: "glm-5.3-flash:fast",
  });
  expect(INCO_DEFAULT_MODEL).toBe("glm-5.3-flash:fast");
});

it("prefers config over environment aliases, trims and removes trailing slashes", () => {
  expect(
    resolveIncoConfig({
      apiKey: " fake ",
      baseURL: " https://config.test/v1/// ",
      model: " config:fast ",
      envBaseURL: "https://env.test/v1",
      envModel: "env:fast",
    }),
  ).toEqual({ apiKey: "fake", baseURL: "https://config.test/v1", model: "config:fast" });
});

it("uses environment aliases then defaults when config values are blank", () => {
  expect(
    resolveIncoConfig({
      apiKey: "fake",
      baseURL: " ",
      model: "",
      envBaseURL: "https://env.test/v1/",
      envModel: "env:fast",
    }),
  ).toEqual({ apiKey: "fake", baseURL: "https://env.test/v1", model: "env:fast" });
  expect(resolveIncoConfig({ apiKey: "fake", envModel: " ", envBaseURL: "" })?.model).toBe(
    INCO_DEFAULT_MODEL,
  );
});

it.each([undefined, null, "", " \n\t"])("is inert for missing/empty key %j", (apiKey) => {
  expect(resolveIncoConfig(apiKey === undefined ? {} : { apiKey })).toBeUndefined();
});

describe("safe maker-supported reasoning levels", () => {
  it.each([
    ["low", "low"],
    ["medium", "low"],
    ["high", "high"],
    ["xhigh", "high"],
    ["max", "high"],
  ] as const)("maps %s to %s, preserving fast model selection", (input, output) => {
    expect(mapIncoReasoningEffort("glm-5.3-flash:fast", input)).toBe(output);
    expect(mapIncoReasoningEffort("glm-5.3", input, true)).toBe(output);
  });
  it("omits unknown model vocabularies, missing effort, and explicit capability denial", () => {
    expect(mapIncoReasoningEffort("unknown", "high", true)).toBeUndefined();
    expect(mapIncoReasoningEffort("glm-5.3-flash:fast", "high", false)).toBeUndefined();
    expect(mapIncoReasoningEffort("glm-5.3-flash:fast", undefined)).toBeUndefined();
    expect(mapIncoReasoningEffort("glm-5.30", "high")).toBeUndefined();
  });
});
