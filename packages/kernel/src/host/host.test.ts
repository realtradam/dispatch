import { beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../bus/bus.js";
import type { AuthContract } from "../contracts/auth.js";
import type {
	ConfigAccess,
	EventsEmitter,
	Extension,
	HostAPI,
	Logger,
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
import type { ProviderContract } from "../contracts/provider.js";
import type { ToolContract } from "../contracts/tool.js";
import { createHost, type HostDeps, KERNEL_API_VERSION } from "./host.js";

interface FakeLogger extends Logger {
	readonly logs: Array<{ level: string; message: string; args: unknown[] }>;
}

function createFakeLogger(): FakeLogger {
	const logs: Array<{ level: string; message: string; args: unknown[] }> = [];
	return {
		logs,
		debug: (message: string, ...args: unknown[]) => {
			logs.push({ level: "debug", message, args });
		},
		info: (message: string, ...args: unknown[]) => {
			logs.push({ level: "info", message, args });
		},
		warn: (message: string, ...args: unknown[]) => {
			logs.push({ level: "warn", message, args });
		},
		error: (message: string, ...args: unknown[]) => {
			logs.push({ level: "error", message, args });
		},
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
	let deps: HostDeps;
	let scheduler: ReturnType<typeof createFakeScheduler>;
	let events: ReturnType<typeof createFakeEvents>;

	beforeEach(() => {
		logger = createFakeLogger();
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
});
