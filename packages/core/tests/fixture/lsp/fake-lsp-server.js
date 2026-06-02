// Minimal JSON-RPC 2.0 LSP-like fake server over stdio, for testing the LSP
// client without a real language server binary. Ported from opencode's
// test/fixture/lsp/fake-lsp-server.js (trimmed to what dispatch's client and
// manager exercise: initialize, didOpen/didChange, push + pull diagnostics).
//
// Test hooks (custom JSON-RPC methods the test driver can call):
//   test/get-initialize-params       → returns the params sent to `initialize`
//   test/get-last-change             → returns the last `didChange` params
//   test/publish-diagnostics         → forwards a `publishDiagnostics` push
//   test/configure-pull-diagnostics  → sets up pull-diagnostic responses
//   test/get-diagnostic-request-count→ how many pull requests were received

let nextId = 1;
let readBuffer = Buffer.alloc(0);
let lastChange = null;
let initializeParams = null;
let diagnosticRequestCount = 0;
let registeredCapability = false;
let pullConfig = {
	registerOn: undefined,
	registrations: [],
	documentDiagnostics: [],
	workspaceDiagnostics: [],
	hasDiagnosticProvider: false,
};

function encode(message) {
	const json = JSON.stringify(message);
	const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
	return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(json, "utf8")]);
}

function decodeFrames(buffer) {
	const results = [];
	while (true) {
		const idx = buffer.indexOf("\r\n\r\n");
		if (idx === -1) break;
		const header = buffer.slice(0, idx).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		const length = match ? parseInt(match[1], 10) : 0;
		const bodyStart = idx + 4;
		const bodyEnd = bodyStart + length;
		if (buffer.length < bodyEnd) break;
		results.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"));
		buffer = buffer.slice(bodyEnd);
	}
	return { messages: results, rest: buffer };
}

function send(message) {
	process.stdout.write(encode(message));
}
function sendRequest(method, params) {
	const id = nextId++;
	send({ jsonrpc: "2.0", id, method, params });
	return id;
}
function sendResponse(id, result) {
	send({ jsonrpc: "2.0", id, result });
}
function sendNotification(method, params) {
	send({ jsonrpc: "2.0", method, params });
}

function maybeRegister(method) {
	if (pullConfig.registerOn !== method || registeredCapability) return;
	registeredCapability = true;
	sendRequest("client/registerCapability", {
		registrations: pullConfig.registrations.map((registration, index) => ({
			id: registration.id ?? `pull-${index}`,
			method: registration.method ?? "textDocument/diagnostic",
			registerOptions: registration.registerOptions ?? registration,
		})),
	});
}

function handle(raw) {
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return;
	}

	if (data.method === "initialize") {
		initializeParams = data.params;
		sendResponse(data.id, {
			capabilities: {
				textDocumentSync: { change: 2, openClose: true },
				...(pullConfig.hasDiagnosticProvider
					? {
							diagnosticProvider: {
								identifier: "fake",
								interFileDependencies: false,
								workspaceDiagnostics: false,
							},
						}
					: {}),
			},
		});
		return;
	}

	if (data.method === "test/get-initialize-params") {
		sendResponse(data.id, initializeParams);
		return;
	}

	if (data.method === "initialized" || data.method === "workspace/didChangeConfiguration") {
		return;
	}

	if (data.method === "textDocument/didOpen") {
		maybeRegister("didOpen");
		return;
	}

	if (data.method === "textDocument/didChange") {
		lastChange = data.params;
		maybeRegister("didChange");
		return;
	}

	if (data.method === "workspace/didChangeWatchedFiles") {
		return;
	}

	if (data.method === "test/configure-pull-diagnostics") {
		pullConfig = {
			registerOn: data.params?.registerOn,
			registrations: data.params?.registrations ?? [],
			documentDiagnostics: data.params?.documentDiagnostics ?? [],
			workspaceDiagnostics: data.params?.workspaceDiagnostics ?? [],
			hasDiagnosticProvider: data.params?.hasDiagnosticProvider ?? false,
		};
		registeredCapability = false;
		sendResponse(data.id, null);
		return;
	}

	if (data.method === "test/publish-diagnostics") {
		sendNotification("textDocument/publishDiagnostics", data.params);
		sendResponse(data.id, null);
		return;
	}

	if (data.method === "test/get-last-change") {
		sendResponse(data.id, lastChange);
		return;
	}

	if (data.method === "test/get-diagnostic-request-count") {
		sendResponse(data.id, diagnosticRequestCount);
		return;
	}

	if (data.method === "textDocument/diagnostic") {
		diagnosticRequestCount += 1;
		sendResponse(data.id, { kind: "full", items: pullConfig.documentDiagnostics });
		return;
	}

	if (data.method === "workspace/diagnostic") {
		diagnosticRequestCount += 1;
		sendResponse(data.id, { items: pullConfig.workspaceDiagnostics });
		return;
	}

	if (data.method === "textDocument/hover") {
		sendResponse(data.id, { contents: { kind: "plaintext", value: "fake hover" } });
		return;
	}

	if (data.method === "textDocument/definition") {
		sendResponse(data.id, [
			{
				uri: data.params?.textDocument?.uri,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			},
		]);
		return;
	}

	// Default: respond null to any other request so the client never hangs.
	if (typeof data.id !== "undefined") {
		sendResponse(data.id, null);
	}
}

process.stdin.on("data", (chunk) => {
	readBuffer = Buffer.concat([readBuffer, chunk]);
	const { messages, rest } = decodeFrames(readBuffer);
	readBuffer = rest;
	for (const message of messages) handle(message);
});
