import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import { languageIdForExtension } from "./language.js";

export type { Diagnostic } from "vscode-languageserver-types";

// ─── Timing constants (mirrors opencode) ─────────────────────────
const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000;
const INITIALIZE_TIMEOUT_MS = 45_000;

// ─── LSP spec constants ──────────────────────────────────────────
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;
const TEXT_DOCUMENT_SYNC_INCREMENTAL = 2;

/**
 * A live spawned language-server process plus the `initializationOptions` to
 * hand it. Produced by the server-spawning layer (`server.ts`) and consumed by
 * `createLspClient`.
 */
export interface LspServerHandle {
	process: ChildProcessWithoutNullStreams;
	initialization?: Record<string, unknown>;
}

interface ServerCapabilities {
	textDocumentSync?: number | { change?: number };
	diagnosticProvider?: unknown;
	[key: string]: unknown;
}

interface DiagnosticRequestResult {
	handled: boolean;
	matched: boolean;
	byFile: Map<string, Diagnostic[]>;
}

interface CapabilityRegistration {
	id: string;
	method: string;
	registerOptions?: {
		identifier?: string;
		workspaceDiagnostics?: boolean;
	};
}

type DocumentDiagnosticReport = {
	items?: Diagnostic[];
	relatedDocuments?: Record<string, DocumentDiagnosticReport>;
};

type WorkspaceDiagnosticReport = {
	items?: { uri?: string; items?: Diagnostic[] }[];
};

/** Public shape of a connected LSP client. */
export interface LspClient {
	readonly serverID: string;
	readonly root: string;
	readonly connection: MessageConnection;
	/**
	 * Open (or re-sync) a file with the server. Returns the document version
	 * sent — pass it to `waitForDiagnostics` to wait for diagnostics matching
	 * this exact sync.
	 */
	notifyOpen(path: string): Promise<number>;
	/** Snapshot of all known diagnostics keyed by absolute file path. */
	readonly diagnostics: Map<string, Diagnostic[]>;
	/** Wait until diagnostics for `path` settle (push and/or pull). */
	waitForDiagnostics(request: {
		path: string;
		version: number;
		mode?: "document" | "full";
		after?: number;
	}): Promise<void>;
	/** Generic LSP request passthrough (hover, definition, references, …). */
	request<T = unknown>(method: string, params: unknown): Promise<T | null>;
	/** Shut the connection and child process down. */
	shutdown(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`LSP request timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

function getFilePath(uri: string): string | undefined {
	if (!uri.startsWith("file://")) return undefined;
	return fileURLToPath(uri);
}

function getSyncKind(capabilities?: ServerCapabilities): number | undefined {
	if (!capabilities) return undefined;
	const sync = capabilities.textDocumentSync;
	if (typeof sync === "number") return sync;
	return sync?.change;
}

function endPosition(text: string) {
	const lines = text.split(/\r\n|\r|\n/);
	return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = JSON.stringify({
			code: item.code,
			severity: item.severity,
			message: item.message,
			source: item.source,
			range: item.range,
		});
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function configurationValue(settings: unknown, section?: string): unknown {
	if (!section) return settings ?? null;
	const result = section.split(".").reduce<unknown>((acc, key) => {
		if (!acc || typeof acc !== "object" || !(key in acc)) return undefined;
		return (acc as Record<string, unknown>)[key];
	}, settings);
	return result ?? null;
}

/**
 * Create and initialize an LSP client over a spawned server's stdio.
 *
 * Performs the full `initialize`/`initialized` handshake (with a 45s timeout),
 * wires push (`textDocument/publishDiagnostics`) and pull
 * (`textDocument/diagnostic`, `workspace/diagnostic`) diagnostics, answers the
 * `workspace/configuration`, `workspaceFolders`, and capability-registration
 * requests servers commonly make, and returns a small client surface used by
 * the manager and tools. Plain-TypeScript port of opencode's `lsp/client.ts`.
 */
export async function createLspClient(input: {
	serverID: string;
	server: LspServerHandle;
	root: string;
	directory: string;
}): Promise<LspClient> {
	const { serverID, server, root, directory } = input;

	const connection = createMessageConnection(
		new StreamMessageReader(server.process.stdout),
		new StreamMessageWriter(server.process.stdin),
	);

	// Server stderr is routine for many tools (luau-lsp logs sourcemap status
	// there). Keep it quiet unless debugging.
	server.process.stderr?.on("data", () => {
		/* swallowed — see opencode: stderr is mostly informational */
	});

	// ─── Connection state ───
	const pushDiagnostics = new Map<string, Diagnostic[]>();
	const pullDiagnostics = new Map<string, Diagnostic[]>();
	const published = new Map<string, { at: number; version?: number }>();
	const diagnosticRegistrations = new Map<string, CapabilityRegistration>();
	const registrationListeners = new Set<() => void>();
	const diagnosticListeners = new Set<(input: { path: string; serverID: string }) => void>();
	const files: Record<string, { version: number; text: string }> = {};

	const mergedDiagnostics = (filePath: string) =>
		dedupeDiagnostics([
			...(pushDiagnostics.get(filePath) ?? []),
			...(pullDiagnostics.get(filePath) ?? []),
		]);
	const updatePushDiagnostics = (filePath: string, next: Diagnostic[]) => {
		pushDiagnostics.set(filePath, next);
		for (const listener of diagnosticListeners) listener({ path: filePath, serverID });
	};
	const updatePullDiagnostics = (filePath: string, next: Diagnostic[]) => {
		pullDiagnostics.set(filePath, next);
	};
	const emitRegistrationChange = () => {
		for (const listener of [...registrationListeners]) listener();
	};

	// ─── Notification / request handlers ───
	connection.onNotification(
		"textDocument/publishDiagnostics",
		(params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
			const filePath = getFilePath(params.uri);
			if (!filePath) return;
			published.set(filePath, {
				at: Date.now(),
				version: typeof params.version === "number" ? params.version : undefined,
			});
			updatePushDiagnostics(filePath, params.diagnostics);
		},
	);
	connection.onRequest("window/workDoneProgress/create", () => null);
	connection.onRequest("workspace/configuration", (params: { items?: { section?: string }[] }) => {
		const items = params.items ?? [];
		return items.map((item) => configurationValue(server.initialization, item.section));
	});
	connection.onRequest(
		"client/registerCapability",
		(params: { registrations?: CapabilityRegistration[] }) => {
			const registrations = params.registrations ?? [];
			let changed = false;
			for (const registration of registrations) {
				if (registration.method !== "textDocument/diagnostic") continue;
				diagnosticRegistrations.set(registration.id, registration);
				changed = true;
			}
			if (changed) emitRegistrationChange();
			return null;
		},
	);
	connection.onRequest(
		"client/unregisterCapability",
		(params: { unregisterations?: { id: string; method: string }[] }) => {
			const registrations = params.unregisterations ?? [];
			let changed = false;
			for (const registration of registrations) {
				if (registration.method !== "textDocument/diagnostic") continue;
				diagnosticRegistrations.delete(registration.id);
				changed = true;
			}
			if (changed) emitRegistrationChange();
			return null;
		},
	);
	connection.onRequest("workspace/workspaceFolders", () => [
		{ name: "workspace", uri: pathToFileURL(root).href },
	]);
	connection.onRequest("workspace/diagnostic/refresh", () => null);
	connection.listen();

	// ─── Initialize handshake ───
	const initialized = await withTimeout(
		connection.sendRequest<{ capabilities?: ServerCapabilities }>("initialize", {
			rootUri: pathToFileURL(root).href,
			processId: server.process.pid ?? null,
			workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
			initializationOptions: { ...server.initialization },
			capabilities: {
				window: { workDoneProgress: true },
				workspace: {
					configuration: true,
					didChangeWatchedFiles: { dynamicRegistration: true },
					diagnostics: { refreshSupport: false },
				},
				textDocument: {
					synchronization: { didOpen: true, didChange: true },
					diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
					publishDiagnostics: { versionSupport: false },
				},
			},
		}),
		INITIALIZE_TIMEOUT_MS,
	);

	const syncKind = getSyncKind(initialized.capabilities);
	const hasStaticPullDiagnostics = Boolean(initialized.capabilities?.diagnosticProvider);

	await connection.sendNotification("initialized", {});
	if (server.initialization) {
		await connection.sendNotification("workspace/didChangeConfiguration", {
			settings: server.initialization,
		});
	}

	// ─── Pull-diagnostics helpers ───
	const mergeResults = (filePath: string, results: DiagnosticRequestResult[]) => {
		const handled = results.some((r) => r.handled);
		const matched = results.some((r) => r.matched);
		if (!handled) return { handled: false, matched: false };

		const merged = new Map<string, Diagnostic[]>();
		for (const result of results) {
			for (const [target, items] of result.byFile.entries()) {
				merged.set(target, (merged.get(target) ?? []).concat(items));
			}
		}
		if (matched && !merged.has(filePath)) merged.set(filePath, []);
		for (const [target, items] of merged.entries()) {
			updatePullDiagnostics(target, dedupeDiagnostics(items));
		}
		return { handled, matched };
	};

	async function requestDiagnosticReport(
		filePath: string,
		identifier?: string,
	): Promise<DiagnosticRequestResult> {
		const report = await withTimeout(
			connection.sendRequest<DocumentDiagnosticReport | null>("textDocument/diagnostic", {
				...(identifier ? { identifier } : {}),
				textDocument: { uri: pathToFileURL(filePath).href },
			}),
			DIAGNOSTICS_REQUEST_TIMEOUT_MS,
		).catch(() => null);
		const empty: DiagnosticRequestResult = {
			handled: false,
			matched: false,
			byFile: new Map(),
		};
		if (!report) return empty;

		const byFile = new Map<string, Diagnostic[]>();
		const push = (target: string, items: Diagnostic[]) => {
			byFile.set(target, (byFile.get(target) ?? []).concat(items));
		};
		let handled = false;
		let matched = false;
		if (Array.isArray(report.items)) {
			push(filePath, report.items);
			handled = true;
			matched = true;
		}
		for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
			const relatedPath = getFilePath(uri);
			if (!relatedPath || !Array.isArray(related.items)) continue;
			push(relatedPath, related.items);
			handled = true;
			matched = matched || relatedPath === filePath;
		}
		return { handled, matched, byFile };
	}

	async function requestWorkspaceDiagnosticReport(
		filePath: string,
		identifier?: string,
	): Promise<DiagnosticRequestResult> {
		const report = await withTimeout(
			connection.sendRequest<WorkspaceDiagnosticReport | null>("workspace/diagnostic", {
				...(identifier ? { identifier } : {}),
				previousResultIds: [],
			}),
			DIAGNOSTICS_REQUEST_TIMEOUT_MS,
		).catch(() => null);
		if (!report) return { handled: false, matched: false, byFile: new Map() };

		const byFile = new Map<string, Diagnostic[]>();
		let matched = false;
		for (const item of report.items ?? []) {
			const relatedPath = item.uri ? getFilePath(item.uri) : undefined;
			if (!relatedPath || !Array.isArray(item.items)) continue;
			byFile.set(relatedPath, (byFile.get(relatedPath) ?? []).concat(item.items));
			matched = matched || relatedPath === filePath;
		}
		return { handled: true, matched, byFile };
	}

	function documentPullState() {
		const documentRegistrations = [...diagnosticRegistrations.values()].filter(
			(r) => r.registerOptions?.workspaceDiagnostics !== true,
		);
		return {
			documentIdentifiers: [
				...new Set(documentRegistrations.flatMap((r) => r.registerOptions?.identifier ?? [])),
			],
			supported: hasStaticPullDiagnostics || documentRegistrations.length > 0,
		};
	}

	function workspacePullState() {
		const workspaceRegistrations = [...diagnosticRegistrations.values()].filter(
			(r) => r.registerOptions?.workspaceDiagnostics === true,
		);
		return {
			workspaceIdentifiers: [
				...new Set(workspaceRegistrations.flatMap((r) => r.registerOptions?.identifier ?? [])),
			],
			supported: workspaceRegistrations.length > 0,
		};
	}

	const hasCurrentFileDiagnostics = (filePath: string, results: DiagnosticRequestResult[]) =>
		results.some((r) => (r.byFile.get(filePath)?.length ?? 0) > 0);

	async function requestDiagnostics(
		filePath: string,
		requests: Promise<DiagnosticRequestResult>[],
		done: (results: DiagnosticRequestResult[]) => boolean,
	) {
		if (!requests.length) return { handled: false, matched: false };
		const results: DiagnosticRequestResult[] = [];
		return new Promise<{ handled: boolean; matched: boolean }>((resolvePromise) => {
			let pending = requests.length;
			let resolved = false;
			const finish = (merged: { handled: boolean; matched: boolean }, force = false) => {
				if (resolved) return;
				if (!force && !done(results)) return;
				resolved = true;
				resolvePromise(merged);
			};
			for (const request of requests) {
				request.then((result) => {
					results.push(result);
					pending -= 1;
					const merged = mergeResults(filePath, results);
					finish(merged);
					if (pending === 0) finish(merged, true);
				});
			}
		});
	}

	async function requestDocumentDiagnostics(filePath: string) {
		const state = documentPullState();
		if (!state.supported) return { handled: false, matched: false };
		return requestDiagnostics(
			filePath,
			[
				requestDiagnosticReport(filePath),
				...state.documentIdentifiers.map((id) => requestDiagnosticReport(filePath, id)),
			],
			(results) => hasCurrentFileDiagnostics(filePath, results),
		);
	}

	async function requestFullDiagnostics(filePath: string) {
		const documentState = documentPullState();
		const workspaceState = workspacePullState();
		if (!documentState.supported && !workspaceState.supported) {
			return { handled: false, matched: false };
		}
		return mergeResults(
			filePath,
			await Promise.all([
				...(documentState.supported ? [requestDiagnosticReport(filePath)] : []),
				...documentState.documentIdentifiers.map((id) => requestDiagnosticReport(filePath, id)),
				...(workspaceState.supported ? [requestWorkspaceDiagnosticReport(filePath)] : []),
				...workspaceState.workspaceIdentifiers.map((id) =>
					requestWorkspaceDiagnosticReport(filePath, id),
				),
			]),
		);
	}

	function waitForRegistrationChange(timeout: number) {
		if (timeout <= 0) return Promise.resolve(false);
		return new Promise<boolean>((resolvePromise) => {
			let finished = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result: boolean) => {
				if (finished) return;
				finished = true;
				if (timer) clearTimeout(timer);
				registrationListeners.delete(listener);
				resolvePromise(result);
			};
			const listener = () => finish(true);
			registrationListeners.add(listener);
			timer = setTimeout(() => finish(false), timeout);
		});
	}

	function waitForFreshPush(request: {
		path: string;
		version: number;
		after: number;
		timeout: number;
	}) {
		if (request.timeout <= 0) return Promise.resolve(false);
		return new Promise<boolean>((resolvePromise) => {
			let finished = false;
			let debounceTimer: ReturnType<typeof setTimeout> | undefined;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
			let unsub: (() => void) | undefined;
			const finish = (result: boolean) => {
				if (finished) return;
				finished = true;
				if (debounceTimer) clearTimeout(debounceTimer);
				if (timeoutTimer) clearTimeout(timeoutTimer);
				unsub?.();
				resolvePromise(result);
			};
			const schedule = () => {
				const hit = published.get(request.path);
				if (!hit) return;
				if (typeof hit.version === "number" && hit.version !== request.version) return;
				if (hit.at < request.after && hit.version !== request.version) return;
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(
					() => finish(true),
					Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)),
				);
			};
			timeoutTimer = setTimeout(() => finish(false), request.timeout);
			const listener = (event: { path: string; serverID: string }) => {
				if (event.path !== request.path || event.serverID !== serverID) return;
				schedule();
			};
			diagnosticListeners.add(listener);
			unsub = () => diagnosticListeners.delete(listener);
			schedule();
		});
	}

	async function waitForDocumentDiagnostics(request: {
		path: string;
		version: number;
		after?: number;
	}) {
		const startedAt = request.after ?? Date.now();
		const pushWait = waitForFreshPush({
			path: request.path,
			version: request.version,
			after: startedAt,
			timeout: DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS,
		});
		while (Date.now() - startedAt < DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS) {
			const result = await requestDocumentDiagnostics(request.path);
			if (result.matched) return;
			const remaining = DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS - (Date.now() - startedAt);
			if (remaining <= 0) return;
			const next = await Promise.race([
				pushWait.then((ready) => (ready ? "push" : "timeout")),
				waitForRegistrationChange(remaining).then((c) => (c ? "registration" : "timeout")),
			]);
			if (next !== "registration") return;
		}
	}

	async function waitForFullDiagnostics(request: {
		path: string;
		version: number;
		after?: number;
	}) {
		const startedAt = request.after ?? Date.now();
		const pushWait = waitForFreshPush({
			path: request.path,
			version: request.version,
			after: startedAt,
			timeout: DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS,
		});
		while (Date.now() - startedAt < DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS) {
			const result = await requestFullDiagnostics(request.path);
			if (result.handled || result.matched) return;
			const remaining = DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS - (Date.now() - startedAt);
			if (remaining <= 0) return;
			const next = await Promise.race([
				pushWait.then((ready) => (ready ? "push" : "timeout")),
				waitForRegistrationChange(remaining).then((c) => (c ? "registration" : "timeout")),
			]);
			if (next !== "registration") return;
		}
	}

	const normalize = (p: string) => (isAbsolute(p) ? p : resolve(directory, p));

	// ─── Public surface ───
	const client: LspClient = {
		serverID,
		root,
		connection,
		async notifyOpen(path: string) {
			const filePath = normalize(path);
			const text = await readFile(filePath, "utf8");
			const languageId = languageIdForExtension(extname(filePath));
			const uri = pathToFileURL(filePath).href;
			const document = files[filePath];

			if (document !== undefined) {
				await connection.sendNotification("workspace/didChangeWatchedFiles", {
					changes: [{ uri, type: FILE_CHANGE_CHANGED }],
				});
				const next = document.version + 1;
				files[filePath] = { version: next, text };
				await connection.sendNotification("textDocument/didChange", {
					textDocument: { uri, version: next },
					contentChanges:
						syncKind === TEXT_DOCUMENT_SYNC_INCREMENTAL
							? [
									{
										range: {
											start: { line: 0, character: 0 },
											end: endPosition(document.text),
										},
										text,
									},
								]
							: [{ text }],
				});
				return next;
			}

			await connection.sendNotification("workspace/didChangeWatchedFiles", {
				changes: [{ uri, type: FILE_CHANGE_CREATED }],
			});
			pushDiagnostics.delete(filePath);
			pullDiagnostics.delete(filePath);
			await connection.sendNotification("textDocument/didOpen", {
				textDocument: { uri, languageId, version: 0, text },
			});
			files[filePath] = { version: 0, text };
			return 0;
		},
		get diagnostics() {
			const result = new Map<string, Diagnostic[]>();
			for (const key of new Set([...pushDiagnostics.keys(), ...pullDiagnostics.keys()])) {
				result.set(key, mergedDiagnostics(key));
			}
			return result;
		},
		async waitForDiagnostics(request) {
			const normalizedPath = normalize(request.path);
			if (request.mode === "document") {
				await waitForDocumentDiagnostics({
					path: normalizedPath,
					version: request.version,
					after: request.after,
				});
				return;
			}
			await waitForFullDiagnostics({
				path: normalizedPath,
				version: request.version,
				after: request.after,
			});
		},
		async request<T = unknown>(method: string, params: unknown): Promise<T | null> {
			return connection.sendRequest<T>(method, params).catch(() => null);
		},
		async shutdown() {
			try {
				connection.end();
				connection.dispose();
			} catch {
				/* connection may already be closed */
			}
			server.process.kill();
		},
	};

	return client;
}
