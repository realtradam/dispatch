import { beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../bus/bus.js";
import type { AuthContract } from "../contracts/auth.js";
import type {
	ConfigAccess,
	EventsEmitter,
	Extension,
	HostAPI,
	Manifest,
	ManifestContributions,
	PermissionDecision,
	PermissionGate,
	PermissionRequest,
	ScheduledJob,
	SecretsAccess,
	StorageNamespace,
} from "../contracts/extension.js";
import { defineEventHook, defineService } from "../contracts/hooks.js";
import type {
	Attributes,
	ErrorAttributes,
	LogDeps,
	Logger,
	LogRecord,
	LogSink,
} from "../contracts/logging.js";
import type { ProviderContract } from "../contracts/provider.js";
import type { ToolContract } from "../contracts/tool.js";
import { createHost, type HostDeps, KERNEL_API_VERSION } from "./host.js";

interface FakeLogger extends Logger {
	readonly logs: Array<{ level: string; message: string; attrs?: Attributes | ErrorAttributes }>;
}

function createFakeLogger(): FakeLogger {
	const logs: Array<{ level: string; message: string; attrs?: Attributes | ErrorAttributes }> = [];
	return {
		logs,
		debug: (message: string, attrs?: Attributes) => {
			if (attrs !== undefined) {
				logs.push({ level: "debug", message, attrs });
			} else {
				logs.push({ level: "debug", message });
			}
		},
		info: (message: string, attrs?: Attributes) => {
			if (attrs !== undefined) {
				logs.push({ level: "info", message, attrs });
			} else {
				logs.push({ level: "info", message });
			}
		},
		warn: (message: string, attrs?: Attributes) => {
			if (attrs !== undefined) {
				logs.push({ level: "warn", message, attrs });
			} else {
				logs.push({ level: "warn", message });
			}
		},
		error: (message: string, attrs?: ErrorAttributes) => {
			if (attrs !== undefined) {
				logs.push({ level: "error", message, attrs });
			} else {
				logs.push({ level: "error", message });
			}
		},
		child(
			_ctx: Partial<import("../contracts/logging.js").LogContext> & { readonly attrs?: Attributes },
		): Logger {
			return createFakeLogger();
		},
		span(_name: string, _attrs?: Attributes): import("../contracts/logging.js").Span {
			return {
				id: "fake-span",
				log: createFakeLogger(),
				setAttributes() {},
				addLink() {},
				child() {
					return this;
				},
				end() {},
			};
		},
	};
}

function createFakeLogSink(): LogSink & { readonly records: LogRecord[] } {
	const records: LogRecord[] = [];
	return {
		records,
		emit: (record: LogRecord) => {
			records.push(record);
		},
	};
}

function createFakeLogDeps(): LogDeps {
	let idCounter = 0;
	return {
		now: () => 1000 + idCounter * 100,
		newId: () => `span-${++idCounter}`,
	};
}

function createFakeConfig(): ConfigAccess {
	return {
		get: () => undefined,
		getAll: () => ({}),
	};
}

function createFakeStorageFactory(): (ns: string) => StorageNamespace {
	const stores = new Map<string, Map<string, string>>();
	return (ns: string) => {
		let store = stores.get(ns);
		if (!store) {
			store = new Map();
			stores.set(ns, store);
		}
		const s = store;
		return {
			get: async (key: string) => s.get(key) ?? null,
			set: async (key: string, value: string) => {
				s.set(key, value);
			},
			delete: async (key: string) => {
				s.delete(key);
			},
			has: async (key: string) => s.has(key),
			keys: async () => [...s.keys()],
		};
	};
}

function createFakeSecrets(): SecretsAccess {
	const store = new Map<string, string>();
	return {
		get: async (key: string) => store.get(key) ?? null,
		set: async (key: string, value: string) => {
			store.set(key, value);
		},
		delete: async (key: string) => {
			store.delete(key);
		},
	};
}

function createFakePermissions(): PermissionGate {
	return {
		check: async (_request: PermissionRequest): Promise<PermissionDecision> => ({
			allowed: true,
		}),
	};
}

function createFakeScheduler(): {
	readonly register: (job: ScheduledJob) => void;
	readonly jobs: ScheduledJob[];
} {
	const jobs: ScheduledJob[] = [];
	return {
		register: (job: ScheduledJob) => {
			jobs.push(job);
		},
		jobs,
	};
}

function createFakeEvents(): EventsEmitter & { readonly emitted: unknown[] } {
	const emitted: unknown[] = [];
	return {
		emitted,
		emit: (event) => {
			emitted.push(event);
		},
	};
}

function createExtension(
	id: string,
	opts: {
		readonly dependsOn?: readonly string[];
		readonly apiVersion?: string;
		readonly activate?: (host: HostAPI) => void | Promise<void>;
		readonly deactivate?: () => void | Promise<void>;
		readonly contributes?: ManifestContributions;
	} = {},
): Extension {
	const base: Manifest = {
		id,
		name: id,
		version: "1.0.0",
		apiVersion: opts.apiVersion ?? `^${KERNEL_API_VERSION}`,
		trust: "bundled",
	};
	const manifest: Manifest =
		opts.dependsOn !== undefined
			? { ...base, dependsOn: opts.dependsOn }
			: opts.contributes !== undefined
				? { ...base, contributes: opts.contributes }
				: base;
	const ext: Extension = {
		manifest,
		activate: opts.activate ?? (() => {}),
	};
	if (opts.deactivate !== undefined) {
		return { ...ext, deactivate: opts.deactivate };
	}
	return ext;
}

function createFakeTool(name: string): ToolContract {
	return {
		name,
		description: `Tool ${name}`,
		parameters: { type: "object" },
		execute: async () => ({ content: "ok" }),
	};
}

function createFakeProvider(id: string): ProviderContract {
	return {
		id,
		stream: async function* () {},
	};
}

function createFakeAuth(id: string): AuthContract {
	return {
		id,
		resolve: async () => null,
	};
}

describe("createHost", () => {
	let logger: FakeLogger;
	let logSink: ReturnType<typeof createFakeLogSink>;
	let logDeps: LogDeps;
	let deps: HostDeps;
	let scheduler: ReturnType<typeof createFakeScheduler>;
	let events: ReturnType<typeof createFakeEvents>;

	beforeEach(() => {
		logger = createFakeLogger();
		logSink = createFakeLogSink();
		logDeps = createFakeLogDeps();
		scheduler = createFakeScheduler();
		events = createFakeEvents();
		deps = {
			logger,
			config: createFakeConfig(),
			storageFactory: createFakeStorageFactory(),
			secrets: createFakeSecrets(),
			permissions: createFakePermissions(),
			scheduler,
			bus: createBus(logger),
			events,
			logSink,
			logDeps,
		};
	});

	describe("activation order", () => {
		it("activates extensions in topological order", async () => {
			const order: string[] = [];

			const a = createExtension("a", {
				activate: () => {
					order.push("a");
				},
			});
			const b = createExtension("b", {
				dependsOn: ["a"],
				activate: () => {
					order.push("b");
				},
			});
			const c = createExtension("c", {
				dependsOn: ["b"],
				activate: () => {
					order.push("c");
				},
			});

			const host = createHost([c, b, a], deps);
			await host.activate();

			expect(order).toEqual(["a", "b", "c"]);
		});

		it("activates independent extensions", async () => {
			const order: string[] = [];

			const a = createExtension("a", {
				activate: () => {
					order.push("a");
				},
			});
			const b = createExtension("b", {
				activate: () => {
					order.push("b");
				},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			expect(order).toHaveLength(2);
			expect(order).toContain("a");
			expect(order).toContain("b");
		});
	});

	describe("fault isolation", () => {
		it("a throwing extension is isolated — others still activate", async () => {
			const order: string[] = [];

			const a = createExtension("a", {
				activate: () => {
					order.push("a");
				},
			});
			const b = createExtension("b", {
				activate: () => {
					throw new Error("boom");
				},
			});
			const c = createExtension("c", {
				activate: () => {
					order.push("c");
				},
			});

			const host = createHost([a, b, c], deps);
			await host.activate();

			expect(order).toEqual(["a", "c"]);
			expect(host.getDisabled()).toHaveLength(1);
			expect(host.getDisabled()[0]?.manifest.id).toBe("b");
			expect(host.getDisabled()[0]?.reason).toContain("boom");
		});

		it("an async-rejecting extension is isolated", async () => {
			const a = createExtension("a", {
				activate: async () => {
					throw new Error("async fail");
				},
			});
			const b = createExtension("b", {
				activate: () => {},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			expect(host.getDisabled()).toHaveLength(1);
			expect(host.getDisabled()[0]?.manifest.id).toBe("a");
		});
	});

	describe("apiVersion compatibility", () => {
		it("activates compatible extensions", async () => {
			const ext = createExtension("good", {
				apiVersion: `^${KERNEL_API_VERSION}`,
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getDisabled()).toHaveLength(0);
		});

		it("disables incompatible extensions without crashing", async () => {
			const ext = createExtension("bad", {
				apiVersion: "^99.0.0",
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getDisabled()).toHaveLength(1);
			expect(host.getDisabled()[0]?.manifest.id).toBe("bad");
			expect(host.getDisabled()[0]?.reason).toContain("incompatible");
		});

		it("logs a warning for disabled extensions", async () => {
			const ext = createExtension("bad", {
				apiVersion: "^99.0.0",
			});

			const host = createHost([ext], deps);
			await host.activate();

			const warnings = logger.logs.filter((l) => l.level === "warn");
			expect(warnings).toHaveLength(1);
			expect(warnings[0]?.message).toContain("bad");
		});
	});

	describe("registries", () => {
		it("defineTool populates the tool registry", async () => {
			const tool = createFakeTool("read-file");
			const ext = createExtension("tools-fs", {
				activate: (host) => {
					host.defineTool(tool);
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getTools().size).toBe(1);
			expect(host.getTool("read-file")).toBe(tool);
		});

		it("defineProvider populates the provider registry", async () => {
			const provider = createFakeProvider("anthropic");
			const ext = createExtension("provider-anthropic", {
				activate: (host) => {
					host.defineProvider(provider);
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getProviders().size).toBe(1);
			expect(host.getProvider("anthropic")).toBe(provider);
		});

		it("defineAuth populates the auth registry", async () => {
			const auth = createFakeAuth("apikey");
			const ext = createExtension("auth-apikey", {
				activate: (host) => {
					host.defineAuth(auth);
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getAuthProviders().size).toBe(1);
			expect(host.getAuthProvider("apikey")).toBe(auth);
		});

		it("getService returns what an extension provided via provideService", async () => {
			const handle = defineService<{ value: number }>("test/svc");
			const ext = createExtension("svc-provider", {
				activate: (host) => {
					host.provideService(handle, { value: 42 });
				},
			});
			const consumer = createExtension("svc-consumer", {
				dependsOn: ["svc-provider"],
				activate: (host) => {
					const svc = host.getService(handle);
					expect(svc.value).toBe(42);
				},
			});

			const host = createHost([ext, consumer], deps);
			await host.activate();

			expect(host.getDisabled()).toHaveLength(0);
		});

		it("multiple extensions contribute to the same registry", async () => {
			const ext1 = createExtension("tools-a", {
				activate: (host) => {
					host.defineTool(createFakeTool("tool-a"));
				},
			});
			const ext2 = createExtension("tools-b", {
				activate: (host) => {
					host.defineTool(createFakeTool("tool-b"));
				},
			});

			const host = createHost([ext1, ext2], deps);
			await host.activate();

			expect(host.getTools().size).toBe(2);
			expect(host.getTool("tool-a")).toBeDefined();
			expect(host.getTool("tool-b")).toBeDefined();
		});
	});

	describe("scheduler", () => {
		it("collects scheduled jobs and forwards to sink", async () => {
			const job: ScheduledJob = {
				id: "cache-warm",
				cron: "*/5 * * * *",
				execute: () => {},
			};
			const ext = createExtension("scheduler-ext", {
				activate: (host) => {
					host.scheduler.register(job);
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getScheduledJobs()).toHaveLength(1);
			expect(host.getScheduledJobs()[0]).toBe(job);
			expect(scheduler.jobs).toHaveLength(1);
			expect(scheduler.jobs[0]).toBe(job);
		});
	});

	describe("migrations", () => {
		it("collects migrations from manifests", async () => {
			const ext = createExtension("store-ext", {
				contributes: { migrations: ["001-init", "002-add-index"] },
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(host.getMigrations()).toEqual(["001-init", "002-add-index"]);
		});
	});

	describe("deactivation", () => {
		it("deactivates in reverse activation order", async () => {
			const order: string[] = [];

			const a = createExtension("a", {
				activate: () => {
					order.push("activate-a");
				},
				deactivate: () => {
					order.push("deactivate-a");
				},
			});
			const b = createExtension("b", {
				activate: () => {
					order.push("activate-b");
				},
				deactivate: () => {
					order.push("deactivate-b");
				},
			});
			const c = createExtension("c", {
				activate: () => {
					order.push("activate-c");
				},
				deactivate: () => {
					order.push("deactivate-c");
				},
			});

			const host = createHost([a, b, c], deps);
			await host.activate();
			await host.deactivate();

			expect(order).toEqual([
				"activate-a",
				"activate-b",
				"activate-c",
				"deactivate-c",
				"deactivate-b",
				"deactivate-a",
			]);
		});

		it("a failing deactivate does not prevent others", async () => {
			const order: string[] = [];

			const a = createExtension("a", {
				activate: () => {},
				deactivate: () => {
					order.push("deactivate-a");
				},
			});
			const b = createExtension("b", {
				activate: () => {},
				deactivate: () => {
					throw new Error("deactivate boom");
				},
			});
			const c = createExtension("c", {
				activate: () => {},
				deactivate: () => {
					order.push("deactivate-c");
				},
			});

			const host = createHost([a, b, c], deps);
			await host.activate();
			await host.deactivate();

			expect(order).toEqual(["deactivate-c", "deactivate-a"]);
			const errors = logger.logs.filter((l) => l.level === "error");
			expect(errors.some((e) => e.message.includes("deactivate"))).toBe(true);
			expect(errors.some((e) => (e.attrs as { err?: unknown })?.err instanceof Error)).toBe(true);
		});
	});

	describe("HostAPI delegation", () => {
		it("on/addFilter delegate to the bus", async () => {
			const hook = defineEventHook<string>("test/host-event");
			const received: string[] = [];

			const ext = createExtension("hook-ext", {
				activate: (host) => {
					host.on(hook, (payload) => {
						received.push(payload);
					});
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			deps.bus.emit(hook, "hello");
			expect(received).toEqual(["hello"]);
		});

		it("storage delegates to the factory", async () => {
			let storageResult: StorageNamespace | undefined;

			const ext = createExtension("storage-ext", {
				activate: (host) => {
					storageResult = host.storage("my-ns");
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(storageResult).toBeDefined();
			await storageResult?.set("key", "value");
			expect(await storageResult?.get("key")).toBe("value");
		});

		it("events delegates to the emitter", async () => {
			const ext = createExtension("event-ext", {
				activate: (host) => {
					host.events.emit({ type: "custom", data: 42 });
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			expect(events.emitted).toHaveLength(1);
			expect(events.emitted[0]).toEqual({ type: "custom", data: 42 });
		});
	});

	describe("HostAPI registry access", () => {
		it("getTools returns registered tools via HostAPI", async () => {
			const tool = createFakeTool("read-file");
			let capturedTools: ReadonlyMap<string, ToolContract> | undefined;

			const producer = createExtension("tools-fs", {
				activate: (host) => {
					host.defineTool(tool);
				},
			});
			const consumer = createExtension("consumer", {
				dependsOn: ["tools-fs"],
				activate: (host) => {
					capturedTools = host.getTools();
				},
			});

			const host = createHost([producer, consumer], deps);
			await host.activate();

			expect(capturedTools).toBeDefined();
			expect(capturedTools?.size).toBe(1);
			expect(capturedTools?.get("read-file")).toBe(tool);
		});

		it("getProviders returns registered providers via HostAPI", async () => {
			const provider = createFakeProvider("anthropic");
			let capturedProviders: ReadonlyMap<string, ProviderContract> | undefined;

			const producer = createExtension("provider-anthropic", {
				activate: (host) => {
					host.defineProvider(provider);
				},
			});
			const consumer = createExtension("consumer", {
				dependsOn: ["provider-anthropic"],
				activate: (host) => {
					capturedProviders = host.getProviders();
				},
			});

			const host = createHost([producer, consumer], deps);
			await host.activate();

			expect(capturedProviders).toBeDefined();
			expect(capturedProviders?.size).toBe(1);
			expect(capturedProviders?.get("anthropic")).toBe(provider);
		});

		it("getAuthProviders/getAuthProvider returns registered auth via HostAPI", async () => {
			const auth = createFakeAuth("apikey");
			let capturedAuth: ReadonlyMap<string, AuthContract> | undefined;
			let capturedSingle: AuthContract | undefined;

			const producer = createExtension("auth-apikey", {
				activate: (host) => {
					host.defineAuth(auth);
				},
			});
			const consumer = createExtension("consumer", {
				dependsOn: ["auth-apikey"],
				activate: (host) => {
					capturedAuth = host.getAuthProviders();
					capturedSingle = host.getAuthProvider("apikey");
				},
			});

			const host = createHost([producer, consumer], deps);
			await host.activate();

			expect(capturedAuth).toBeDefined();
			expect(capturedAuth?.size).toBe(1);
			expect(capturedAuth?.get("apikey")).toBe(auth);
			expect(capturedSingle).toBe(auth);
		});
	});

	describe("getExtensions", () => {
		it("returns empty array when no extensions are activated", async () => {
			const host = createHost([], deps);
			await host.activate();

			expect(host.getExtensions()).toEqual([]);
		});

		it("returns manifests of all activated extensions", async () => {
			const a = createExtension("ext-a");
			const b = createExtension("ext-b");

			const host = createHost([a, b], deps);
			await host.activate();

			const exts = host.getExtensions();
			expect(exts).toHaveLength(2);
			expect(exts.map((e) => e.id)).toContain("ext-a");
			expect(exts.map((e) => e.id)).toContain("ext-b");
		});

		it("returns manifests in activation order", async () => {
			const a = createExtension("a");
			const b = createExtension("b", { dependsOn: ["a"] });
			const c = createExtension("c", { dependsOn: ["b"] });

			const host = createHost([c, b, a], deps);
			await host.activate();

			const exts = host.getExtensions();
			expect(exts.map((e) => e.id)).toEqual(["a", "b", "c"]);
		});

		it("excludes extensions that failed to activate", async () => {
			const a = createExtension("good");
			const b = createExtension("bad", {
				activate: () => {
					throw new Error("boom");
				},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			const exts = host.getExtensions();
			expect(exts).toHaveLength(1);
			expect(exts[0]?.id).toBe("good");
		});

		it("excludes extensions disabled by apiVersion incompatibility", async () => {
			const good = createExtension("good");
			const bad = createExtension("bad", { apiVersion: "^99.0.0" });

			const host = createHost([good, bad], deps);
			await host.activate();

			const exts = host.getExtensions();
			expect(exts).toHaveLength(1);
			expect(exts[0]?.id).toBe("good");
		});

		it("returns a frozen array", async () => {
			const ext = createExtension("ext");
			const host = createHost([ext], deps);
			await host.activate();

			const exts = host.getExtensions();
			expect(Object.isFrozen(exts)).toBe(true);
		});

		it("HostAPI getExtensions reflects activated extensions after full activation", async () => {
			const a = createExtension("ext-a");
			const b = createExtension("ext-b", {
				dependsOn: ["ext-a"],
				activate: () => {},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			// Use getHostAPI() to verify the post-activation view
			const api = host.getHostAPI();
			const capturedExtsAfter = api.getExtensions();

			expect(capturedExtsAfter).toHaveLength(2);
			expect(capturedExtsAfter.map((e) => e.id)).toEqual(["ext-a", "ext-b"]);
		});

		it("HostAPI getExtensions during activation sees only previously activated", async () => {
			const seenDuringActivation: string[][] = [];

			const a = createExtension("a", {
				activate: (host) => {
					seenDuringActivation.push(host.getExtensions().map((e) => e.id));
				},
			});
			const b = createExtension("b", {
				activate: (host) => {
					seenDuringActivation.push(host.getExtensions().map((e) => e.id));
				},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			// When a activates, activated[] is empty (a hasn't been pushed yet)
			// When b activates, activated[] has [a] (b hasn't been pushed yet)
			expect(seenDuringActivation).toEqual([[], ["a"]]);
		});
	});

	describe("DAG errors", () => {
		it("throws on missing dependency", () => {
			const ext = createExtension("a", { dependsOn: ["missing"] });
			expect(() => createHost([ext], deps)).toThrow(/not available/);
		});

		it("throws on dependency cycle", () => {
			const a = createExtension("a", { dependsOn: ["b"] });
			const b = createExtension("b", { dependsOn: ["a"] });
			expect(() => createHost([a, b], deps)).toThrow(/cycle/i);
		});
	});

	describe("empty host", () => {
		it("works with no extensions", async () => {
			const host = createHost([], deps);
			await host.activate();

			expect(host.getTools().size).toBe(0);
			expect(host.getProviders().size).toBe(0);
			expect(host.getAuthProviders().size).toBe(0);
			expect(host.getScheduledJobs()).toHaveLength(0);
			expect(host.getMigrations()).toHaveLength(0);
			expect(host.getDisabled()).toHaveLength(0);
		});
	});

	describe("getHostAPI", () => {
		it("returns a HostAPI whose read-views reflect registrations from activation", async () => {
			const tool = createFakeTool("read-file");
			const provider = createFakeProvider("anthropic");
			const auth = createFakeAuth("apikey");

			const ext = createExtension("multi-ext", {
				activate: (host) => {
					host.defineTool(tool);
					host.defineProvider(provider);
					host.defineAuth(auth);
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const api = host.getHostAPI();

			expect(api.getTools().size).toBe(1);
			expect(api.getTools().get("read-file")).toBe(tool);

			expect(api.getProviders().size).toBe(1);
			expect(api.getProviders().get("anthropic")).toBe(provider);

			expect(api.getAuthProviders().size).toBe(1);
			expect(api.getAuthProvider("apikey")).toBe(auth);
		});

		it("throws on defineTool after activation", async () => {
			const ext = createExtension("ext", { activate: () => {} });
			const host = createHost([ext], deps);
			await host.activate();

			const api = host.getHostAPI();
			expect(() => api.defineTool(createFakeTool("late"))).toThrow(
				"Registration not available after activation",
			);
		});

		it("throws on defineProvider after activation", async () => {
			const ext = createExtension("ext", { activate: () => {} });
			const host = createHost([ext], deps);
			await host.activate();

			const api = host.getHostAPI();
			expect(() => api.defineProvider(createFakeProvider("late"))).toThrow(
				"Registration not available after activation",
			);
		});

		it("throws on defineAuth after activation", async () => {
			const ext = createExtension("ext", { activate: () => {} });
			const host = createHost([ext], deps);
			await host.activate();

			const api = host.getHostAPI();
			expect(() => api.defineAuth(createFakeAuth("late"))).toThrow(
				"Registration not available after activation",
			);
		});
	});

	describe("auto-scoped logger (D6)", () => {
		it("each extension's logger stamps its own manifest.id as extensionId", async () => {
			let extALogger: Logger | undefined;
			let extBLogger: Logger | undefined;

			const a = createExtension("ext-a", {
				activate: (host) => {
					extALogger = host.logger;
				},
			});
			const b = createExtension("ext-b", {
				activate: (host) => {
					extBLogger = host.logger;
				},
			});

			const host = createHost([a, b], deps);
			await host.activate();

			extALogger?.info("from-a");
			extBLogger?.info("from-b");

			const logRecords = logSink.records.filter((r) => r.kind === "log");
			expect(logRecords).toHaveLength(2);
			if (logRecords[0]?.kind === "log") {
				expect(logRecords[0].extensionId).toBe("ext-a");
				expect(logRecords[0].msg).toBe("from-a");
			}
			if (logRecords[1]?.kind === "log") {
				expect(logRecords[1].extensionId).toBe("ext-b");
				expect(logRecords[1].msg).toBe("from-b");
			}
		});

		it("an extension cannot spoof extensionId — it is auto-stamped", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("real-id", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			// child() cannot override extensionId
			const child = extLogger?.child({ extensionId: "spoofed" });
			child?.info("msg");

			const logRecords = logSink.records.filter((r) => r.kind === "log");
			expect(logRecords).toHaveLength(1);
			if (logRecords[0]?.kind === "log") {
				expect(logRecords[0].extensionId).toBe("real-id");
			}
		});

		it("host.logger.error uses structured { err } shape", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			extLogger?.error("something broke", { err: new Error("boom") });

			const logRecords = logSink.records.filter((r) => r.kind === "log");
			expect(logRecords).toHaveLength(1);
			if (logRecords[0]?.kind === "log") {
				expect(logRecords[0].level).toBe("error");
				expect(logRecords[0].msg).toBe("something broke");
				expect(logRecords[0].attributes?.["error.message"]).toBe("boom");
			}
		});

		it("a throwing sink does NOT break the caller", async () => {
			const brokenSink: LogSink = {
				emit() {
					throw new Error("sink down");
				},
			};
			const brokenDeps: HostDeps = {
				...deps,
				logSink: brokenSink,
			};

			let extLogger: Logger | undefined;
			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], brokenDeps);
			await host.activate();

			// Should not throw
			expect(() => extLogger?.info("msg")).not.toThrow();
		});

		it("span() + end() emit incremental span-open and span-close records", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("my-span", { key: "value" });
			span?.setAttributes({ extra: "attr" });
			span?.end({ attrs: { result: "ok" } });

			const spanOpens = logSink.records.filter((r) => r.kind === "span-open");
			const spanCloses = logSink.records.filter((r) => r.kind === "span-close");

			expect(spanOpens).toHaveLength(1);
			expect(spanCloses).toHaveLength(1);

			if (spanOpens[0]?.kind === "span-open") {
				expect(spanOpens[0].name).toBe("my-span");
				expect(spanOpens[0].extensionId).toBe("ext");
				expect(spanOpens[0].attributes?.key).toBe("value");
			}
			if (spanCloses[0]?.kind === "span-close") {
				expect(spanCloses[0].name).toBe("my-span");
				expect(spanCloses[0].status).toBe("ok");
				expect(spanCloses[0].durationMs).toBeGreaterThanOrEqual(0);
				expect(spanCloses[0].attributes?.extra).toBe("attr");
				expect(spanCloses[0].attributes?.result).toBe("ok");
			}
		});

		it("span() with body emits body on span-open record", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("with-body", { key: "value" }, '{"payload":"hello"}');
			span?.end();

			const spanOpens = logSink.records.filter((r) => r.kind === "span-open");
			expect(spanOpens).toHaveLength(1);
			if (spanOpens[0]?.kind === "span-open") {
				expect(spanOpens[0].body).toBe('{"payload":"hello"}');
			}
		});

		it("span() without body omits body field on span-open record", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("no-body");
			span?.end();

			const spanOpens = logSink.records.filter((r) => r.kind === "span-open");
			expect(spanOpens).toHaveLength(1);
			if (spanOpens[0]?.kind === "span-open") {
				expect(spanOpens[0].body).toBeUndefined();
			}
		});

		it("child() with body emits body on child span-open record", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("parent");
			const child = span?.child("child-name", { k: "v" }, '{"child":"body"}');
			child?.end();
			span?.end();

			const spanOpens = logSink.records.filter((r) => r.kind === "span-open");
			const childOpen = spanOpens.find((r) => r.kind === "span-open" && r.name === "child-name");
			expect(childOpen).toBeDefined();
			if (childOpen?.kind === "span-open") {
				expect(childOpen.body).toBe('{"child":"body"}');
			}
		});

		it("end() with body emits body on span-close record", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("close-body");
			span?.end({ body: '{"result":"data"}' });

			const spanCloses = logSink.records.filter((r) => r.kind === "span-close");
			expect(spanCloses).toHaveLength(1);
			if (spanCloses[0]?.kind === "span-close") {
				expect(spanCloses[0].body).toBe('{"result":"data"}');
			}
		});

		it("end() without body omits body field on span-close record", async () => {
			let extLogger: Logger | undefined;

			const ext = createExtension("ext", {
				activate: (host) => {
					extLogger = host.logger;
				},
			});

			const host = createHost([ext], deps);
			await host.activate();

			const span = extLogger?.span("no-close-body");
			span?.end();

			const spanCloses = logSink.records.filter((r) => r.kind === "span-close");
			expect(spanCloses).toHaveLength(1);
			if (spanCloses[0]?.kind === "span-close") {
				expect(spanCloses[0].body).toBeUndefined();
			}
		});
	});
});
