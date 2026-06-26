import type { ToolContract } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { convertTools } from "./convert-tools.js";

describe("convertTools", () => {
  it("converts a single tool to OpenAI function format", () => {
    const tools: ToolContract[] = [
      {
        name: "read_file",
        description: "Read a file from disk",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async () => ({ content: "" }),
      },
    ];

    const result = convertTools(tools);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path" },
            },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
    ]);
  });

  it("converts multiple tools", () => {
    const tools: ToolContract[] = [
      {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
        execute: async () => ({ content: "" }),
      },
      {
        name: "run_shell",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command" },
          },
          required: ["command"],
        },
        execute: async () => ({ content: "" }),
      },
    ];

    const result = convertTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.name).toBe("read_file");
    expect(result[1]?.function.name).toBe("run_shell");
  });

  it("returns empty array for no tools", () => {
    const result = convertTools([]);
    expect(result).toEqual([]);
  });

  it("preserves nested parameter schema properties", () => {
    const tools: ToolContract[] = [
      {
        name: "search",
        description: "Search code",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            options: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Max results", default: 10 },
              },
            },
          },
          required: ["query"],
        },
        execute: async () => ({ content: "" }),
      },
    ];

    const result = convertTools(tools);
    expect(result[0]?.function.parameters.properties?.options).toEqual({
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results", default: 10 },
      },
    });
  });
});
