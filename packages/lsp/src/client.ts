/**
 * Language-server client — wires codec + rpc + edges; runs the
 * initialize handshake, honors server→client requests, runs the
 * FileWatcher, and forwards matching disk changes.
 */

import { DiagnosticsStore, type PublishDiagnosticsParams } from "./diagnostics.js";
import { computeChangeRange } from "./diff.js";
import { FrameDecoder } from "./framing.js";
import { languageId as resolveLanguageId } from "./language.js";
import { JsonRpcConnection, type WriteFn } from "./rpc.js";
import { FileChangeType, WatchedFilesRegistry } from "./watched-files.js";

export interface SpawnedProcess {
	readonly stdin: { readonly write: (bytes: Uint8Array) => void };
	readonly stdout:
		| AsyncIterable<Uint8Array>
		| { readonly on: (event: string, cb: (data: Uint8Array) => void) => void };
	readonly stderr?:
		| AsyncIterable<Uint8Array>
		| { readonly on: (event: string, cb: (data: Uint8Array) => void) => void }
		| undefined;
	readonly pid: number | undefined;
	readonly kill: () => void;
}

export type SpawnProcess = (
	command: string[],
	opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> | undefined },
) => SpawnedProcess;

export interface FileWatcherHandle {
	readonly close: () => void;
}

export type FileWatcher = (
	root: string,
	onEvent: (e: { readonly type: "create" | "change" | "delete"; readonly path: string }) => void,
) => FileWatcherHandle;

export interface FsAccess {
	readonly readText: (path: string) => Promise<string>;
	readonly exists: (path: string) => Promise<boolean>;
}

export interface ClientCapabilities {
	readonly window: { readonly workDoneProgress: boolean };
	readonly workspace: {
		readonly configuration: boolean;
		readonly didChangeWatchedFiles: { readonly dynamicRegistration: boolean };
		readonly diagnostics: { readonly refreshSupport: boolean };
	};
	readonly textDocument: {
		readonly synchronization: { readonly didOpen: boolean; readonly didChange: boolean };
		readonly diagnostic: {
			readonly dynamicRegistration: boolean;
			readonly relatedDocumentSupport: boolean;
		};
		readonly publishDiagnostics: { readonly versionSupport: boolean };
	};
}

export const CLIENT_CAPABILITIES: ClientCapabilities = {
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
};

export interface ClientDeps {
	readonly spawn: SpawnProcess;
	readonly fileWatcher: FileWatcher;
	readonly fs: FsAccess;
	readonly command: readonly string[];
	readonly env?: Readonly<Record<string, string>> | undefined;
	readonly root: string;
	readonly initialization?: Readonly<Record<string, unknown>> | undefined;
	readonly serverId: string;
}

export type ClientState = "starting" | "connected" | "error" | "not-started";

export class LanguageServerClient {
	readonly serverId: string;
	readonly root: string;
	private process: SpawnedProcess | null = null;
	private rpc: JsonRpcConnection | null = null;
	private decoder = new FrameDecoder();
	private diagnostics = new DiagnosticsStore();
	private watchedFiles = new WatchedFilesRegistry();
	private fileWatcherHandle: FileWatcherHandle | null = null;
	private state: ClientState = "not-started";
	private stateError: string | undefined;
	private deps: ClientDeps;
	private openDocuments = new Map<string, { version: number; text: string }>();
	/** Sync mode captured from the server's initialize capabilities: 1=Full, 2=Incremental. */
	private textDocumentChange: 1 | 2 = 1;

	constructor(deps: ClientDeps) {
		this.deps = deps;
		this.serverId = deps.serverId;
		this.root = deps.root;
	}

	getState(): ClientState {
		return this.state;
	}

	getStateError(): string | undefined {
		return this.stateError;
	}

	async start(): Promise<void> {
		this.state = "starting";
		try {
			const spawnOpts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> } = {
				cwd: this.root,
			};
			if (this.deps.env) {
				(spawnOpts as { env?: Readonly<Record<string, string>> }).env = this.deps.env;
			}
			const proc = this.deps.spawn(this.deps.command as string[], spawnOpts);
			this.process = proc;

			const writeFn: WriteFn = (bytes) => proc.stdin.write(bytes);
			const rpc = new JsonRpcConnection(writeFn);
			this.rpc = rpc;

			this.setupServerHandlers(rpc);

			const stdoutSource = proc.stdout;
			if (Symbol.asyncIterator in stdoutSource) {
				this.readFromAsyncIterable(stdoutSource as AsyncIterable<Uint8Array>);
			} else {
				this.readFromEventSource(
					stdoutSource as { readonly on: (event: string, cb: (data: Uint8Array) => void) => void },
				);
			}

			await this.initialize(rpc);
			this.state = "connected";
		} catch (err: unknown) {
			this.state = "error";
			this.stateError = err instanceof Error ? err.message : String(err);
		}
	}

	private readFromAsyncIterable(source: AsyncIterable<Uint8Array>): void {
		(async () => {
			try {
				for await (const chunk of source) {
					this.handleBytes(chunk);
				}
			} catch {
				// process exited
			}
		})();
	}

	private readFromEventSource(source: {
		readonly on: (event: string, cb: (data: Uint8Array) => void) => void;
	}): void {
		source.on("data", (data: Uint8Array) => {
			this.handleBytes(data);
		});
	}

	private handleBytes(chunk: Uint8Array): void {
		const messages = this.decoder.decode(chunk);
		for (const msg of messages) {
			this.rpc?.handleMessage(msg);
		}
	}

	private setupServerHandlers(rpc: JsonRpcConnection): void {
		rpc.onNotification("textDocument/publishDiagnostics", (params) => {
			this.diagnostics.setPushDiagnostics(params as PublishDiagnosticsParams);
		});

		rpc.onRequest("workspace/configuration", (params) => {
			const { items } = params as { readonly items: readonly { readonly section?: string }[] };
			const init = this.deps.initialization ?? {};
			return items.map((item) => {
				if (item.section) {
					const keys = item.section.split(".");
					let value: unknown = init;
					for (const key of keys) {
						if (value && typeof value === "object" && key in value) {
							value = (value as Record<string, unknown>)[key];
						} else {
							return undefined;
						}
					}
					return value;
				}
				return init;
			});
		});

		rpc.onRequest("workspace/workspaceFolders", () => {
			return [{ uri: `file://${this.root}`, name: this.root }];
		});

		rpc.onRequest("window/workDoneProgress/create", () => null);
		rpc.onRequest("workspace/diagnostic/refresh", () => null);

		rpc.onRequest("client/registerCapability", (params) => {
			const { registrations } = params as {
				readonly registrations: readonly {
					readonly id: string;
					readonly method: string;
					readonly registerOptions?: unknown;
				}[];
			};
			for (const reg of registrations) {
				if (reg.method === "textDocument/diagnostic") {
					// Store diagnostic registration (future use)
				} else if (reg.method === "workspace/didChangeWatchedFiles") {
					const opts = reg.registerOptions as
						| import("./watched-files.js").DidChangeWatchedFilesRegistrationOptions
						| undefined;
					if (opts) {
						this.watchedFiles.applyRegister({
							id: reg.id,
							method: reg.method,
							registerOptions: opts,
						});
					}
				}
			}
			return null;
		});

		rpc.onRequest("client/unregisterCapability", (params) => {
			const { unregistrations } = params as {
				readonly unregistrations: readonly {
					readonly id: string;
					readonly method: string;
				}[];
			};
			for (const unreg of unregistrations) {
				this.watchedFiles.applyUnregister(unreg);
			}
			return null;
		});
	}

	private async initialize(rpc: JsonRpcConnection): Promise<void> {
		const timeout = 45_000;

		const initPromise = rpc.sendRequest("initialize", {
			processId: this.process?.pid ?? null,
			rootUri: `file://${this.root}`,
			workspaceFolders: [{ uri: `file://${this.root}`, name: this.root }],
			capabilities: CLIENT_CAPABILITIES,
		});

		const timeoutPromise = new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("Initialize timeout")), timeout);
		});

		const result = (await Promise.race([initPromise, timeoutPromise])) as {
			readonly capabilities?: {
				readonly textDocumentSync?:
					| number
					| { readonly openClose?: boolean; readonly change?: number }
					| undefined;
			};
		};

		// Capture the server's text document sync mode for didChange.
		const sync = result.capabilities?.textDocumentSync;
		if (typeof sync === "number") {
			this.textDocumentChange = sync as 1 | 2;
		} else if (sync && typeof sync === "object" && sync.change !== undefined) {
			this.textDocumentChange = sync.change as 1 | 2;
		}

		rpc.sendNotification("initialized", {});

		if (this.deps.initialization) {
			rpc.sendNotification("workspace/didChangeConfiguration", {
				settings: this.deps.initialization,
			});
		}

		this.startFileWatcher();
	}

	private startFileWatcher(): void {
		const rootPrefix = this.root.endsWith("/") ? this.root : `${this.root}/`;
		this.fileWatcherHandle = this.deps.fileWatcher(this.root, (event) => {
			const changeType =
				event.type === "create"
					? FileChangeType.Created
					: event.type === "delete"
						? FileChangeType.Deleted
						: FileChangeType.Changed;

			const relativePath = event.path.startsWith(rootPrefix)
				? event.path.slice(rootPrefix.length)
				: event.path.replace(/^\/+/, "");

			if (this.watchedFiles.matches(relativePath)) {
				this.rpc?.sendNotification("workspace/didChangeWatchedFiles", {
					changes: [{ uri: `file://${event.path}`, type: changeType }],
				});
			}
		});
	}

	async open(filePath: string): Promise<void> {
		const rpc = this.rpc;
		if (!rpc || this.state !== "connected") return;

		try {
			const text = await this.deps.fs.readText(filePath);
			await this.openWithText(filePath, text);
		} catch {
			// file may not exist
		}
	}

	async openWithText(filePath: string, text: string, langId?: string): Promise<void> {
		const rpc = this.rpc;
		if (!rpc || this.state !== "connected") return;

		// If already open, use didChange instead of re-opening.
		if (this.openDocuments.has(filePath)) {
			await this.change(filePath, text);
			return;
		}

		const version = 1;
		this.openDocuments.set(filePath, { version, text });

		rpc.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri: `file://${filePath}`,
				languageId: langId ?? resolveLanguageId(filePath),
				version,
				text,
			},
		});
	}

	async change(filePath: string, newText: string): Promise<void> {
		const rpc = this.rpc;
		if (!rpc || this.state !== "connected") return;

		const existing = this.openDocuments.get(filePath);
		if (!existing) {
			// Not open yet — didOpen instead.
			await this.openWithText(filePath, newText);
			return;
		}

		const version = existing.version + 1;
		this.openDocuments.set(filePath, { version, text: newText });

		if (this.textDocumentChange === 2) {
			// Incremental sync — compute the minimal change range.
			const changeEvent = computeChangeRange(existing.text, newText);
			rpc.sendNotification("textDocument/didChange", {
				textDocument: { uri: `file://${filePath}`, version },
				contentChanges: [changeEvent],
			});
		} else {
			// Full sync — send the entire content.
			rpc.sendNotification("textDocument/didChange", {
				textDocument: { uri: `file://${filePath}`, version },
				contentChanges: [{ text: newText }],
			});
		}
	}

	async waitForDiagnostics(
		filePath: string,
		opts?: { readonly text?: string; readonly timeoutMs?: number; readonly minSeverity?: number },
	): Promise<{ readonly formatted: string; readonly slow: boolean; readonly timedOut: boolean }> {
		const timeoutMs = opts?.timeoutMs ?? 10_000;
		const uri = `file://${filePath}`;

		// Clear the "received" flag so we detect fresh publishDiagnostics after our sync.
		this.diagnostics.clearReceived(uri);

		// Sync the document: use didChange with the provided text (post-edit buffer)
		// or fall back to didOpen reading from disk.
		if (opts?.text !== undefined) {
			await this.change(filePath, opts.text);
		} else {
			await this.open(filePath);
		}

		const slowThreshold = 10_000;
		const start = Date.now();

		// Poll until the server pushes diagnostics (even empty = done) or timeout.
		return new Promise((resolve) => {
			const check = () => {
				const elapsed = Date.now() - start;
				const received = this.diagnostics.hasReceivedPush(uri);
				if (received || elapsed >= timeoutMs) {
					resolve({
						formatted: this.diagnostics.formatFiltered(uri, opts?.minSeverity),
						slow: elapsed > slowThreshold,
						timedOut: !received,
					});
					return;
				}
				setTimeout(check, 100);
			};
			check();
		});
	}

	getWatchedFilesRegistry(): WatchedFilesRegistry {
		return this.watchedFiles;
	}

	getDiagnosticsStore(): DiagnosticsStore {
		return this.diagnostics;
	}

	async request(method: string, params?: unknown): Promise<unknown> {
		if (!this.rpc || this.state !== "connected") {
			throw new Error("Client not connected");
		}
		return this.rpc.sendRequest(method, params);
	}

	shutdown(): void {
		this.fileWatcherHandle?.close();
		this.fileWatcherHandle = null;
		this.process?.kill();
		this.process = null;
		this.rpc?.dispose();
		this.rpc = null;
		this.state = "not-started";
	}
}
