/**
 * Compile-time assertions for transport-contract types.
 *
 * These are never executed — they exist solely to prove the exported types
 * compile with conforming literals. If a shape changes, this file fails to
 * typecheck.
 */

import { describe, expect, it } from "vitest";
import type {
  ChatRequest,
  Computer,
  ComputerEntry,
  ComputerListResponse,
  ComputerResponse,
  ComputerStatusResponse,
  ConversationComputerResponse,
  CreateNamedAgentRequest,
  CwdResponse,
  DeleteNamedAgentResponse,
  LspServerInfo,
  LspServerState,
  LspStatusResponse,
  McpStatusResponse,
  ModelResponse,
  ModelsResponse,
  NamedAgent,
  NamedAgentResponse,
  NamedAgentsResponse,
  SetConversationComputerRequest,
  SetCwdRequest,
  SetWorkspaceDefaultComputerRequest,
  TestComputerResponse,
  UpdateNamedAgentRequest,
} from "./index.js";

// ─── CwdResponse ─────────────────────────────────────────────────────────────

const _cwdNull: CwdResponse = {
  conversationId: "conv-1",
  cwd: null,
};

const _cwdSet: CwdResponse = {
  conversationId: "conv-2",
  cwd: "/home/user/project",
};

// ─── SetCwdRequest ───────────────────────────────────────────────────────────

const _setCwd: SetCwdRequest = {
  cwd: "/tmp/workspace",
};

// ─── ChatRequest.computerId (additive optional) ──────────────────────────────

const _chatWithComputer: ChatRequest = {
  message: "run the test suite",
  computerId: "prod-box",
};

const _chatWithoutComputer: ChatRequest = {
  message: "hello",
};

// ─── ChatRequest.images (additive optional) ──────────────────────────────────

const _chatWithImages: ChatRequest = {
  message: "What's in this screenshot?",
  images: [{ url: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" }],
};

const _chatWithHttpImage: ChatRequest = {
  message: "analyze this",
  images: [{ url: "https://example.com/diagram.png" }],
};

// ─── ChatRequest.title (additive optional) ───────────────────────────────────

const _chatWithTitle: ChatRequest = {
  message: "implement the feature",
  title: "Summon: add --title flag",
};

const _chatWithoutTitle: ChatRequest = {
  message: "hello",
};

// ─── Computer list / single response ─────────────────────────────────────────

const _computer: Computer = {
  alias: "prod-box",
  hostName: "10.0.0.5",
  port: 22,
  user: "deploy",
  identityFile: "/home/user/.ssh/id_ed25519",
  knownHost: true,
};

const _computerEntry: ComputerEntry = {
  ..._computer,
  usageCount: 3,
};

const _computerList: ComputerListResponse = {
  computers: [_computerEntry],
};

const _computerResponse: ComputerResponse = _computer;

// ─── Computer status / test probe ────────────────────────────────────────────

const _statusConnected: ComputerStatusResponse = {
  alias: "prod-box",
  state: "connected",
  knownHost: true,
};

const _statusError: ComputerStatusResponse = {
  alias: "prod-box",
  state: "error",
  error: "connection refused",
  knownHost: false,
};

const _testOk: TestComputerResponse = {
  alias: "prod-box",
  ok: true,
};

const _testFail: TestComputerResponse = {
  alias: "prod-box",
  ok: false,
  error: "auth failed",
};

// ─── Per-conversation + workspace computer ───────────────────────────────────

const _setConvComputer: SetConversationComputerRequest = {
  computerId: "prod-box",
};

const _clearConvComputer: SetConversationComputerRequest = {
  computerId: null,
};

const _convComputer: ConversationComputerResponse = {
  conversationId: "conv-1",
  computerId: "prod-box",
};

const _convComputerNull: ConversationComputerResponse = {
  conversationId: "conv-2",
  computerId: null,
};

const _setDefaultComputer: SetWorkspaceDefaultComputerRequest = {
  computerId: null,
};

// ─── LspServerState ──────────────────────────────────────────────────────────

const _stateConnected: LspServerState = "connected";
const _stateStarting: LspServerState = "starting";
const _stateError: LspServerState = "error";
const _stateNotStarted: LspServerState = "not-started";

// ─── LspServerInfo ───────────────────────────────────────────────────────────

const _serverOk: LspServerInfo = {
  id: "typescript",
  name: "TypeScript Language Server",
  root: "/home/user/project",
  extensions: [".ts", ".tsx"],
  state: "connected",
};

const _serverErr: LspServerInfo = {
  id: "luau-lsp",
  name: "Luau LSP",
  root: "/home/user/game",
  extensions: [".luau"],
  state: "error",
  error: "Failed to start: binary not found",
};

const _serverWithSource: LspServerInfo = {
  id: "ruby-lsp",
  name: "Ruby LSP",
  root: "/home/user/raylib",
  extensions: [".rb"],
  state: "connected",
  configSource: ".dispatch/lsp.json",
};

// ─── LspStatusResponse ───────────────────────────────────────────────────────

const _lspNoCwd: LspStatusResponse = {
  conversationId: "conv-3",
  cwd: null,
  servers: [],
};

const _lspWithServers: LspStatusResponse = {
  conversationId: "conv-4",
  cwd: "/home/user/project",
  servers: [_serverOk, _serverErr],
};

// ─── Runtime smoke (vitest needs a suite) ────────────────────────────────────

describe("transport-contract types compile and are exported", () => {
  it("CwdResponse: null cwd round-trips", () => {
    expect(_cwdNull).toEqual({ conversationId: "conv-1", cwd: null });
  });

  it("CwdResponse: set cwd round-trips", () => {
    expect(_cwdSet.cwd).toBe("/home/user/project");
  });

  it("SetCwdRequest: carries cwd", () => {
    expect(_setCwd.cwd).toBe("/tmp/workspace");
  });

  it("LspServerState: all four variants are valid", () => {
    const states: LspServerState[] = [
      _stateConnected,
      _stateStarting,
      _stateError,
      _stateNotStarted,
    ];
    expect(states).toHaveLength(4);
  });

  it("LspServerInfo: ok server has no error field", () => {
    expect(_serverOk.state).toBe("connected");
    expect(_serverOk.error).toBeUndefined();
  });

  it("LspServerInfo: error server carries error message", () => {
    expect(_serverErr.state).toBe("error");
    expect(_serverErr.error).toBe("Failed to start: binary not found");
  });

  it("LspServerInfo: carries optional configSource", () => {
    expect(_serverWithSource.configSource).toBe(".dispatch/lsp.json");
    expect(_serverOk.configSource).toBeUndefined();
  });

  it("LspStatusResponse: empty servers when cwd is null", () => {
    expect(_lspNoCwd.servers).toEqual([]);
  });

  it("LspStatusResponse: populated servers when cwd is set", () => {
    expect(_lspWithServers.servers).toHaveLength(2);
  });

  // ─── MCP status ─────────────────────────────────────────────────────────────

  it("McpStatusResponse: empty servers when cwd is null", () => {
    const _noCwd: McpStatusResponse = { conversationId: "c1", cwd: null, servers: [] };
    expect(_noCwd.servers).toEqual([]);
  });

  it("McpStatusResponse: populated servers when cwd is set", () => {
    const _withServers: McpStatusResponse = {
      conversationId: "c2",
      cwd: "/home/user/project",
      servers: [
        { id: "freecad", state: "connected", toolCount: 12, configSource: ".dispatch/mcp.json" },
        { id: "chrome", state: "error", error: "spawn failed", toolCount: 0 },
      ],
    };
    expect(_withServers.servers).toHaveLength(2);
    expect(_withServers.servers[0]?.toolCount).toBe(12);
    expect(_withServers.servers[1]?.error).toBe("spawn failed");
  });

  // ─── ChatRequest.computerId ──────────────────────────────────────────────

  it("ChatRequest: computerId is additive optional (omittable)", () => {
    expect(_chatWithoutComputer.computerId).toBeUndefined();
  });

  it("ChatRequest: carries computerId when set", () => {
    expect(_chatWithComputer.computerId).toBe("prod-box");
  });

  // ─── ChatRequest.images (additive optional) ──────────────────────────────

  it("ChatRequest: images is additive optional (omittable)", () => {
    expect(_chatWithoutComputer.images).toBeUndefined();
  });

  it("ChatRequest: carries images (data URL) when set", () => {
    expect(_chatWithImages.images).toHaveLength(1);
    expect(_chatWithImages.images?.[0]?.url).toContain("base64");
    expect(_chatWithImages.images?.[0]?.mimeType).toBe("image/png");
  });

  it("ChatRequest: carries images (http URL, mimeType optional)", () => {
    expect(_chatWithHttpImage.images?.[0]?.url).toBe("https://example.com/diagram.png");
    expect(_chatWithHttpImage.images?.[0]?.mimeType).toBeUndefined();
  });

  // ─── ChatRequest.title (additive optional) ────────────────────────────────

  it("ChatRequest: title is additive optional (omittable)", () => {
    expect(_chatWithoutTitle.title).toBeUndefined();
  });

  it("ChatRequest: carries title when set", () => {
    expect(_chatWithTitle.title).toBe("Summon: add --title flag");
  });

  it("ModelsResponse: ModelMetadata carries optional vision flag", () => {
    const resp: ModelsResponse = {
      models: ["umans/kimi-k2.7", "umans/glm-5.2"],
      modelInfo: {
        "umans/kimi-k2.7": { contextWindow: 200000, vision: true },
        "umans/glm-5.2": { contextWindow: 128000 },
      },
    };
    expect(resp.modelInfo?.["umans/kimi-k2.7"]?.vision).toBe(true);
    expect(resp.modelInfo?.["umans/glm-5.2"]?.vision).toBeUndefined();
  });

  // ─── Computers ───────────────────────────────────────────────────────────

  it("ComputerListResponse: carries entries with usage counts", () => {
    expect(_computerList.computers).toHaveLength(1);
    expect(_computerList.computers[0]?.usageCount).toBe(3);
    expect(_computerList.computers[0]?.alias).toBe("prod-box");
  });

  it("ComputerResponse: is a single Computer", () => {
    expect(_computerResponse.alias).toBe("prod-box");
    expect(_computerResponse.port).toBe(22);
  });

  it("ComputerStatusResponse: all four states are valid", () => {
    const states: ComputerStatusResponse["state"][] = [
      "disconnected",
      "connecting",
      "connected",
      "error",
    ];
    expect(states).toHaveLength(4);
  });

  it("ComputerStatusResponse: connected has no error field", () => {
    expect(_statusConnected.state).toBe("connected");
    expect(_statusConnected.error).toBeUndefined();
  });

  it("ComputerStatusResponse: error carries message", () => {
    expect(_statusError.state).toBe("error");
    expect(_statusError.error).toBe("connection refused");
  });

  it("TestComputerResponse: ok has no error field", () => {
    expect(_testOk.ok).toBe(true);
    expect(_testOk.error).toBeUndefined();
  });

  it("TestComputerResponse: failure carries error", () => {
    expect(_testFail.ok).toBe(false);
    expect(_testFail.error).toBe("auth failed");
  });

  it("SetConversationComputerRequest: null clears to inherit/local", () => {
    expect(_setConvComputer.computerId).toBe("prod-box");
    expect(_clearConvComputer.computerId).toBeNull();
  });

  it("ConversationComputerResponse: null computerId round-trips", () => {
    expect(_convComputer.computerId).toBe("prod-box");
    expect(_convComputerNull.computerId).toBeNull();
  });

  it("SetWorkspaceDefaultComputerRequest: null clears to local", () => {
    expect(_setDefaultComputer.computerId).toBeNull();
  });

  // ─── Named Agents ──────────────────────────────────────────────────────

  it("NamedAgentsResponse: lists configured Named Agents", () => {
    const resp: NamedAgentsResponse = {
      namedAgents: [
        { id: "na-1", name: "Coding Agent", model: "opencode-1/claude-sonnet-4.5" },
        { id: "na-2", name: "Research Agent", model: "umans/umans-glm-5.2" },
      ],
    };
    expect(resp.namedAgents).toHaveLength(2);
    expect(resp.namedAgents[0]?.name).toBe("Coding Agent");
  });

  it("NamedAgentResponse: carries a single canonical record", () => {
    const resp: NamedAgentResponse = {
      namedAgent: { id: "na-1", name: "Fast Agent", model: "hyper/some-fast-model" },
    };
    expect(resp.namedAgent.id).toBe("na-1");
    expect(resp.namedAgent.model).toBe("hyper/some-fast-model");
  });

  it("CreateNamedAgentRequest / UpdateNamedAgentRequest: carry name + model", () => {
    const create: CreateNamedAgentRequest = { name: "Coding Agent", model: "opencode-1/m" };
    const update: UpdateNamedAgentRequest = { name: "Research Agent", model: "umans/m" };
    expect(create.name).toBe("Coding Agent");
    expect(update.model).toBe("umans/m");
  });

  it("DeleteNamedAgentResponse: carries the stable id", () => {
    const del: DeleteNamedAgentResponse = { id: "na-1" };
    expect(del.id).toBe("na-1");
  });

  it("ModelResponse: namedAgent is a NamedAgentSelectionSnapshot (compile-time assignable)", () => {
    const namedAgent: NamedAgent = { id: "na-1", name: "Coding", model: "opencode-1/m" };
    // NamedAgentResponse expects a NamedAgent — satisfies the re-export.
    const resp: NamedAgentResponse = { namedAgent };
    expect(resp.namedAgent.id).toBe("na-1");

    // ModelResponse carries the selection snapshot.
    const modelResp: ModelResponse = {
      conversationId: "c1",
      model: "opencode-1/m",
      namedAgent: { namedAgentId: "na-1", namedAgentName: "Coding", model: "opencode-1/m" },
    };
    expect(modelResp.namedAgent?.namedAgentId).toBe("na-1");
  });
});

it("queue HTTP/WS inputs and snapshots carry additive image/computer metadata", () => {
  const request: import("./index.js").QueueRequest = {
    text: "",
    images: [{ url: "data:image/png;base64,AAAA", mimeType: "image/png" }],
    computerId: "remote",
  };
  const ws: import("./index.js").ChatQueueMessage = {
    type: "chat.queue",
    conversationId: "c",
    ...request,
  };
  const response: import("./index.js").QueuedMessage = {
    id: "q",
    text: request.text,
    queuedAt: 0,
    images: request.images ?? [],
    computerId: request.computerId ?? "remote",
    imageCount: 1,
  };
  expect(ws.images).toEqual(response.images);
  expect(ws.computerId).toBe(response.computerId);
});

it("types additive queued acknowledgement and optional send correlation", () => {
  const send: import("./index.js").ChatSendMessage = {
    type: "chat.send",
    message: "mine",
    requestId: "request-1",
  };
  const ack: import("./index.js").WsServerMessage = {
    type: "chat.queued",
    conversationId: "c",
    reason: "compaction",
    messageId: "item-1",
    requestId: send.requestId ?? "",
  };
  expect(ack.type).toBe("chat.queued");
});

it("accepts additive resync notices with and without a turn identity", () => {
  const replay: import("./index.js").WsServerMessage = {
    type: "chat.resync-required",
    conversationId: "c",
    turnId: "t",
    reason: "replay-limit",
  };
  const live: import("./index.js").WsServerMessage = {
    type: "chat.resync-required",
    conversationId: "c",
    reason: "payload-limit",
  };
  expect(replay.type).toBe("chat.resync-required");
  expect(live.type).toBe("chat.resync-required");
});
