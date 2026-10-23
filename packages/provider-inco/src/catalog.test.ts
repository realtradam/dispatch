import { expect, it } from "vitest";
import { parseIncoModels } from "./index.js";

it("preserves live IDs including distinct standard/fast labels and context lengths", () => {
  expect(
    parseIncoModels({
      data: [
        {
          id: "glm-5.3-flash",
          name: "GLM 5.3 Flash",
          context_length: 1048576,
          capabilities: { reasoning_effort: true },
          modalities: { input: ["text", "image", "video"] },
        },
        {
          id: "glm-5.3-flash:fast",
          name: "GLM 5.3 Flash (Fast)",
          context_length: 1048576,
          capabilities: { reasoning_effort: true },
          modalities: { input: ["text", "image", "video"] },
        },
        { id: "glm-5.3", modalities: { input: ["text"] } },
      ],
    }),
  ).toEqual([
    {
      id: "glm-5.3-flash",
      displayName: "GLM 5.3 Flash",
      contextWindow: 1048576,
      vision: true,
      reasoningEffort: true,
    },
    {
      id: "glm-5.3-flash:fast",
      displayName: "GLM 5.3 Flash (Fast)",
      contextWindow: 1048576,
      vision: true,
      reasoningEffort: true,
    },
    { id: "glm-5.3", vision: false },
  ]);
});

it("uses explicit modalities rather than name heuristics and never advertises video", () => {
  expect(
    parseIncoModels({
      data: [
        { id: "vision-model", modalities: { input: ["text"] } },
        { id: "video-only", modalities: { input: ["video"] } },
        { id: "unknown-vision" },
        { id: "reasoning-disabled", capabilities: { reasoning_effort: false } },
      ],
    }),
  ).toEqual([
    { id: "vision-model", vision: false },
    { id: "video-only", vision: false },
    { id: "unknown-vision" },
    { id: "reasoning-disabled", reasoningEffort: false },
  ]);
});

it("rejects malformed envelopes but skips invalid rows and metadata", () => {
  for (const payload of [null, [], {}, { data: null }, { data: {} }]) {
    expect(() => parseIncoModels(payload)).toThrow("malformed models response");
  }
  expect(
    parseIncoModels({
      data: [
        null,
        [],
        {},
        { id: 5 },
        { id: " " },
        {
          id: "valid",
          name: 12,
          context_length: -1,
          capabilities: { reasoning_effort: "true" },
          modalities: { input: ["image", 2] },
        },
        { id: "fractional", context_length: 2.5 },
        { id: "infinite", context_length: Infinity },
      ],
    }),
  ).toEqual([{ id: "valid" }, { id: "fractional" }, { id: "infinite" }]);
  expect(parseIncoModels({ data: [] })).toEqual([]);
});
