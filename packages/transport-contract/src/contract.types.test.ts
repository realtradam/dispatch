/**
 * Compile-time assertions for transport-contract types.
 *
 * These are never executed — they exist solely to prove the exported types
 * compile with conforming literals. If a shape changes, this file fails to
 * typecheck.
 */

import { describe, expect, it } from "vitest";
import type {
	CwdResponse,
	LspServerInfo,
	LspServerState,
	LspStatusResponse,
	SetCwdRequest,
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
});
