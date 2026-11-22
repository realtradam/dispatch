import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  TextFileContextResponse,
  TextFileQuery,
  TextFileResponse,
  TextFileVersionQuery,
  TextFileVersionResponse,
  TextFileWriteConflictResponse,
  TextFileWriteRequest,
  TextFileWriteResponse,
} from "./index.js";

describe("text-file transport type boundaries", () => {
  it("exports a readonly query with a required path and optional string guards", () => {
    expectTypeOf<TextFileQuery>().toEqualTypeOf<{
      readonly path: string;
      readonly expectedCwd?: string;
      readonly expectedComputerId?: string;
    }>();
    expectTypeOf<Omit<TextFileQuery, "path">>().not.toMatchTypeOf<TextFileQuery>();
    expectTypeOf<{ path: string; expectedCwd: null }>().not.toMatchTypeOf<TextFileQuery>();
    expectTypeOf<{ path: string; expectedComputerId: null }>().not.toMatchTypeOf<TextFileQuery>();
  });

  it("allows omitted guards without asserting a context", () => {
    const query: TextFileQuery = { path: "notes/plan.md" };
    expect(query).toEqual({ path: "notes/plan.md" });
    expect(query.expectedCwd).toBeUndefined();
    expect(query.expectedComputerId).toBeUndefined();
  });

  it("carries both effective context guards, including the empty local guard", () => {
    const query: TextFileQuery = {
      path: "notes/plan.md",
      expectedCwd: "/home/user/project",
      expectedComputerId: "",
    };
    expect(query.expectedCwd).toBe("/home/user/project");
    expect(query.expectedComputerId).toBe("");
  });

  it("carries empty guards distinctly from omitted guards", () => {
    const query: TextFileQuery = {
      path: "/tmp/notes.txt",
      expectedCwd: "",
      expectedComputerId: "",
    };
    expect(new URLSearchParams({ ...query }).toString()).toBe(
      "path=%2Ftmp%2Fnotes.txt&expectedCwd=&expectedComputerId=",
    );
  });

  it("round-trips a raw literal path through URL query encoding exactly once", () => {
    const query: TextFileQuery = { path: "notes/literal%20 + #? résumé.md" };
    const encoded = new URLSearchParams({ ...query }).toString();
    expect(encoded).toContain("literal%2520");
    expect(new URLSearchParams(encoded).get("path")).toBe(query.path);
  });

  it("exports a readonly complete response with only markdown and text formats", () => {
    expectTypeOf<TextFileResponse>().toEqualTypeOf<{
      readonly path: string;
      readonly text: string;
      readonly format: "markdown" | "text";
      readonly bytes: number;
      readonly maxBytes: number;
      readonly version: string;
    }>();
    expectTypeOf<Omit<TextFileResponse, "maxBytes">>().not.toMatchTypeOf<TextFileResponse>();
    expectTypeOf<Omit<TextFileResponse, "bytes">>().not.toMatchTypeOf<TextFileResponse>();
    expectTypeOf<"html">().not.toMatchTypeOf<TextFileResponse["format"]>();
  });

  it("exports the version query and response types", () => {
    expectTypeOf<TextFileVersionQuery>().toEqualTypeOf<TextFileQuery>();
    expectTypeOf<TextFileVersionResponse>().toEqualTypeOf<{
      readonly path: string;
      readonly version: string;
    }>();
  });

  it("carries markdown content and the current byte limit", () => {
    const response: TextFileResponse = {
      path: "/home/user/project/notes/plan.md",
      text: "# Plan\n",
      format: "markdown",
      bytes: 7,
      maxBytes: 262144,
      version: "1-2-3-4",
    };
    expect(response.format).toBe("markdown");
    expect(response.bytes).toBe(7);
    expect(response.maxBytes).toBe(256 * 1024);
  });

  it("carries plain UTF-8 text with a byte count distinct from string length", () => {
    const response: TextFileResponse = {
      path: "/tmp/notes.txt",
      text: "é\n",
      format: "text",
      bytes: 3,
      maxBytes: 262144,
      version: "1-2-3-4",
    };
    expect(response.format).toBe("text");
    expect(response.text).toHaveLength(2);
    expect(response.bytes).toBe(3);
  });

  it("exports a readonly effective-context response with required nullable fields", () => {
    expectTypeOf<TextFileContextResponse>().toEqualTypeOf<{
      readonly conversationId: string;
      readonly cwd: string | null;
      readonly computerId: string | null;
    }>();
    expectTypeOf<
      Omit<TextFileContextResponse, "cwd">
    >().not.toMatchTypeOf<TextFileContextResponse>();
    expectTypeOf<
      Omit<TextFileContextResponse, "computerId">
    >().not.toMatchTypeOf<TextFileContextResponse>();
  });

  it("carries unset/local or resolved remote context for guarded file requests", () => {
    const local: TextFileContextResponse = {
      conversationId: "conv-local",
      cwd: null,
      computerId: null,
    };
    const remote: TextFileContextResponse = {
      conversationId: "conv-remote",
      cwd: "/home/user/project",
      computerId: "remote",
    };
    const query: TextFileQuery = {
      path: "/tmp/notes.txt",
      expectedCwd: local.cwd ?? "",
      expectedComputerId: local.computerId ?? "",
    };
    expect(query.expectedCwd).toBe("");
    expect(query.expectedComputerId).toBe("");
    expect(remote.cwd).toBe("/home/user/project");
    expect(remote.computerId).toBe("remote");
  });

  it("exports a readonly conditional write request with a required expectedVersion", () => {
    expectTypeOf<TextFileWriteRequest>().toEqualTypeOf<{
      readonly path: string;
      readonly text: string;
      readonly expectedVersion: string;
      readonly expectedCwd?: string;
      readonly expectedComputerId?: string;
    }>();
    expectTypeOf<
      Omit<TextFileWriteRequest, "expectedVersion">
    >().not.toMatchTypeOf<TextFileWriteRequest>();
    expectTypeOf<Omit<TextFileWriteRequest, "text">>().not.toMatchTypeOf<TextFileWriteRequest>();
    const request: TextFileWriteRequest = {
      path: "diagrams/flow.excalidraw",
      text: '{"type":"excalidraw","version":2,"elements":[]}',
      expectedVersion: "1-2-3-4",
      expectedCwd: "",
      expectedComputerId: "",
    };
    expect(request.expectedVersion).toBe("1-2-3-4");
  });

  it("exports the write success and 412 conflict response types", () => {
    expectTypeOf<TextFileWriteResponse>().toEqualTypeOf<{
      readonly path: string;
      readonly version: string;
      readonly bytes: number;
      readonly maxBytes: number;
    }>();
    expectTypeOf<TextFileWriteConflictResponse>().toEqualTypeOf<{
      readonly error: string;
      readonly version: string;
    }>();
    const saved: TextFileWriteResponse = {
      path: "/home/user/project/diagrams/flow.excalidraw",
      version: "1-9-48-5",
      bytes: 48,
      maxBytes: 16 * 1024 * 1024,
    };
    expect(saved.maxBytes).toBe(16777216);
  });
});
