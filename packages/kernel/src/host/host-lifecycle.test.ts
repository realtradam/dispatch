import { beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../bus/bus.js";
import type { AuthContract } from "../contracts/auth.js";
import type {
  ConfigAccess,
  EventsEmitter,
  Extension,
  HostAPI,
  Manifest,
  PermissionDecision,
  PermissionGate,
  PermissionRequest,
  ScheduledJob,
  SecretsAccess,
  StorageNamespace,
} from "../contracts/extension.js";
import { defineEventHook, defineFilter, defineService } from "../contracts/hooks.js";
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

// ── Injected fakes (effects, not mocks of our own modules) ───────────────

interface FakeLogger extends Logger {
  readonly logs: Array<{ level: string; message: string; attrs?: Attributes | ErrorAttributes }>;
}

function createFakeLogger(): FakeLogger {
  const logs: Array<{ level: string; message: string; attrs?: Attributes | ErrorAttributes }> = [];
  return {
    logs,
    debug: (message: string, attrs?: Attributes) => {
      logs.push(
        attrs !== undefined ? { level: "debug", message, attrs } : { level: "debug", message },
      );
    },
    info: (message: string, attrs?: Attributes) => {
      logs.push(
        attrs !== undefined ? { level: "info", message, attrs } : { level: "info", message },
      );
    },
    warn: (message: string, attrs?: Attributes) => {
      logs.push(
        attrs !== undefined ? { level: "warn", message, attrs } : { level: "warn", message },
      );
    },
    error: (message: string, attrs?: ErrorAttributes) => {
      logs.push(
        attrs !== undefined ? { level: "error", message, attrs } : { level: "error", message },
      );
    },
    child(): Logger {
      return createFakeLogger();
    },
    span(_name: string): import("../contracts/logging.js").Span {
      const span: import("../contracts/logging.js").Span = {
        id: "fake-span",
        log: createFakeLogger(),
        setAttributes() {},
        addLink() {},
        child() {
          return this;
        },
        end() {},
      };
      return span;
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
  return { get: () => undefined, getAll: () => ({}) };
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
  readonly unregister: (jobId: string) => void;
  readonly jobs: ScheduledJob[];
  readonly unregistered: string[];
} {
  const jobs: ScheduledJob[] = [];
  const unregistered: string[] = [];
  return {
    register: (job: ScheduledJob) => {
      jobs.push(job);
    },
    unregister: (jobId: string) => {
      // a real scheduler stops the job — mirror that here
      unregistered.push(jobId);
      const idx = jobs.findIndex((j) => j.id === jobId);
      if (idx !== -1) jobs.splice(idx, 1);
    },
    jobs,
    unregistered,
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

// ── Fixture builders ─────────────────────────────────────────────────────

function createExtension(
  id: string,
  opts: {
    readonly dependsOn?: readonly string[];
    readonly apiVersion?: string;
    readonly activate?: (host: HostAPI) => void | Promise<void>;
    readonly deactivate?: () => void | Promise<void>;
  } = {},
): Extension {
  const base: Manifest = {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: opts.apiVersion ?? `^${KERNEL_API_VERSION}`,
    tier: "standard",
    trust: "bundled",
  };
  const manifest: Manifest =
    opts.dependsOn !== undefined ? { ...base, dependsOn: opts.dependsOn } : base;
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

describe("runtime load/unload/reload", () => {
  let logger: FakeLogger;
  let logSink: ReturnType<typeof createFakeLogSink>;
  let logDeps: LogDeps;
  let scheduler: ReturnType<typeof createFakeScheduler>;
  let events: ReturnType<typeof createFakeEvents>;
  let deps: HostDeps;

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

  describe("loadExtension", () => {
    it("activates a new extension at runtime; its registrations become visible", async () => {
      const tool = createFakeTool("late-tool");
      const handle = defineService<string>("late/svc");
      const ext = createExtension("late", {
        activate: (host) => {
          host.defineTool(tool);
          host.provideService(handle, "impl");
        },
      });

      const host = createHost([], deps);
      await host.activate();
      const result = await host.loadExtension(ext);

      expect(result.ok).toBe(true);
      expect(result.manifest?.id).toBe("late");
      expect(host.getTool("late-tool")).toBe(tool);
      expect(deps.bus.getService(handle)).toBe("impl");
      expect(host.getExtensions().map((m) => m.id)).toEqual(["late"]);
    });

    it("refuses an already-loaded id (use reloadExtension)", async () => {
      const host = createHost([createExtension("dup")], deps);
      await host.activate();

      const result = await host.loadExtension(createExtension("dup"));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("reloadExtension");
      expect(host.getExtensions()).toHaveLength(1);
    });

    it("routes an apiVersion-incompatible extension to disabled-with-reason", async () => {
      const host = createHost([], deps);
      await host.activate();

      const result = await host.loadExtension(createExtension("stale", { apiVersion: "^99.0.0" }));

      expect(result.ok).toBe(false);
      expect(result.disabled?.reason).toContain("incompatible");
      expect(host.getDisabled()).toHaveLength(1);
      expect(host.getDisabled()[0]?.manifest.id).toBe("stale");
      expect(host.getExtensions()).toHaveLength(0);
    });

    it("routes an unmet dependency to disabled-with-reason (non-throwing)", async () => {
      const host = createHost([], deps);
      await host.activate();

      const result = await host.loadExtension(createExtension("needy", { dependsOn: ["ghost"] }));

      expect(result.ok).toBe(false);
      expect(result.disabled?.reason).toContain("ghost");
      expect(result.disabled?.reason).toContain("not loaded");
      expect(host.getDisabled()).toHaveLength(1);
    });

    it("accepts a dependency that is currently loaded", async () => {
      const dep = createExtension("dep");
      const host = createHost([dep], deps);
      await host.activate();

      const result = await host.loadExtension(createExtension("dependent", { dependsOn: ["dep"] }));
      expect(result.ok).toBe(true);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["dep", "dependent"]);
    });

    it("on activation throw: prior state preserved, partial registrations swept, disabled entry added", async () => {
      const tool = createFakeTool("survivor");
      const before = createExtension("before", {
        activate: (host) => {
          host.defineTool(tool);
        },
      });
      const bad = createExtension("bad", {
        activate: (host) => {
          host.defineTool(createFakeTool("partial"));
          throw new Error("boom mid-activate");
        },
      });

      const host = createHost([before], deps);
      await host.activate();
      const result = await host.loadExtension(bad);

      expect(result.ok).toBe(false);
      expect(result.disabled?.reason).toContain("boom mid-activate");
      // prior state preserved
      expect(host.getTool("survivor")).toBe(tool);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["before"]);
      // partial registrations swept — never leave the system broken
      expect(host.getTool("partial")).toBeUndefined();
      expect(host.getDisabled().some((d) => d.manifest.id === "bad")).toBe(true);
    });

    it("a successful load clears a stale disabled-with-reason entry for the same id", async () => {
      const host = createHost([], deps);
      await host.activate();
      await host.loadExtension(createExtension("flaky", { apiVersion: "^99.0.0" }));
      expect(host.getDisabled()).toHaveLength(1);

      const result = await host.loadExtension(createExtension("flaky"));
      expect(result.ok).toBe(true);
      expect(host.getDisabled()).toHaveLength(0);
    });
  });

  describe("unloadExtension", () => {
    it("removes every registration the extension made", async () => {
      const hook = defineEventHook<string>("lifecycle/event");
      const filter = defineFilter<string>("lifecycle/filter");
      const handle = defineService<string>("lifecycle/svc");
      const job: ScheduledJob = { id: "lifecycle-job", cron: "* * * * *", execute: () => {} };
      const tool = createFakeTool("late-tool");
      const provider = createFakeProvider("late-provider");
      const auth = createFakeAuth("late-auth");
      const received: string[] = [];
      let schedulerApi: HostAPI["scheduler"] | undefined;
      let unprovide: (() => void) | undefined;
      let unsub: (() => void) | undefined;
      let unfilter: (() => void) | undefined;

      const ext = createExtension("everything", {
        activate: (host) => {
          host.defineTool(tool);
          host.defineProvider(provider);
          host.defineAuth(auth);
          unprovide = host.provideService(handle, "impl");
          unsub = host.on(hook, (payload) => {
            received.push(payload);
          });
          unfilter = host.addFilter(filter, (v) => v);
          schedulerApi = host.scheduler;
          schedulerApi.register(job);
        },
        deactivate: () => {
          unprovide?.();
          unsub?.();
          unfilter?.();
          schedulerApi?.unregister("lifecycle-job");
        },
      });

      const host = createHost([ext], deps);
      await host.activate();
      expect(host.getTools().size).toBe(1);
      expect(host.getScheduledJobs()).toHaveLength(1);

      const result = await host.unloadExtension("everything");

      expect(result.ok).toBe(true);
      expect(result.dangling).toBeUndefined(); // the extension disposed everything
      expect(host.getTool("late-tool")).toBeUndefined();
      expect(host.getProvider("late-provider")).toBeUndefined();
      expect(host.getAuthProvider("late-auth")).toBeUndefined();
      expect(host.getScheduledJobs()).toHaveLength(0);
      expect(scheduler.unregistered).toContain("lifecycle-job");
      expect(host.getExtensions()).toHaveLength(0);
      // the subscription is gone: emits reach nothing
      deps.bus.emit(hook, "nobody-home");
      expect(received).toEqual([]);
      // the filter is gone
      expect(await deps.bus.applyFilters(filter, "x")).toBe("x");
      // the service is un-provided
      expect(() => deps.bus.getService(handle)).toThrow();
    });

    it("refuses while a loaded extension depends on the target (reports dependents)", async () => {
      const base = createExtension("base");
      const dependent = createExtension("dependent", { dependsOn: ["base"] });
      const host = createHost([base, dependent], deps);
      await host.activate();

      const result = await host.unloadExtension("base");

      expect(result.ok).toBe(false);
      expect(result.blockedBy).toEqual(["dependent"]);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["base", "dependent"]);
    });

    it("force unloads despite dependents (cascade policy is the caller's)", async () => {
      const base = createExtension("base");
      const dependent = createExtension("dependent", { dependsOn: ["base"] });
      const host = createHost([base, dependent], deps);
      await host.activate();

      const result = await host.unloadExtension("base", { force: true });
      expect(result.ok).toBe(true);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["dependent"]);
    });

    it("force-cleans and logs a deactivate that leaks registrations", async () => {
      const handle = defineService<string>("leaky/svc");
      const filter = defineFilter<string>("leaky/filter");
      const job: ScheduledJob = { id: "leaky-job", cron: "* * * * *", execute: () => {} };

      const leaky = createExtension("leaky", {
        activate: (host) => {
          host.provideService(handle, "impl");
          host.addFilter(filter, (v) => v);
          host.scheduler.register(job);
          // NOT disposed anywhere: deactivate does nothing
        },
        deactivate: () => {},
      });

      const host = createHost([leaky], deps);
      await host.activate();

      const result = await host.unloadExtension("leaky");

      expect(result.ok).toBe(true);
      expect(result.dangling).toEqual([
        { kind: "service", id: "leaky/svc" },
        { kind: "filter", id: "leaky/filter" },
        { kind: "job", id: "leaky-job" },
      ]);
      // force-cleaned for real
      expect(() => deps.bus.getService(handle)).toThrow();
      expect(host.getScheduledJobs()).toHaveLength(0);
      expect(scheduler.unregistered).toContain("leaky-job");
      // loud logging with the §9 wording
      const warns = logger.logs.filter((l) => l.level === "warn");
      expect(
        warns.some((w) => w.message.includes('dangling registration from plugin "leaky"')),
      ).toBe(true);
    });

    it("an extension with no deactivate still has disposals force-cleaned", async () => {
      const handle = defineService<string>("nodeactivate/svc");
      const ext = createExtension("nodeactivate", {
        activate: (host) => {
          host.provideService(handle, "impl");
        },
      });

      const host = createHost([ext], deps);
      await host.activate();

      const result = await host.unloadExtension("nodeactivate");
      expect(result.ok).toBe(true);
      expect(result.dangling).toEqual([{ kind: "service", id: "nodeactivate/svc" }]);
      expect(() => deps.bus.getService(handle)).toThrow();
    });

    it("a throwing deactivate still completes the unload (force-cleans + logs)", async () => {
      const handle = defineService<string>("throwing/svc");
      const ext = createExtension("throwing", {
        activate: (host) => {
          host.provideService(handle, "impl");
        },
        deactivate: () => {
          throw new Error("deactivate boom");
        },
      });

      const host = createHost([ext], deps);
      await host.activate();

      const result = await host.unloadExtension("throwing");

      expect(result.ok).toBe(true);
      expect(result.deactivateError).toBe("deactivate boom");
      expect(result.dangling).toEqual([{ kind: "service", id: "throwing/svc" }]);
      expect(host.getExtensions()).toHaveLength(0);
      expect(() => deps.bus.getService(handle)).toThrow();
      const errors = logger.logs.filter((l) => l.level === "error");
      expect(errors.some((e) => e.message.includes("failed to deactivate"))).toBe(true);
    });

    it("refuses an id that is not loaded", async () => {
      const host = createHost([], deps);
      await host.activate();

      const result = await host.unloadExtension("ghost");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("not loaded");
    });

    it("does NOT add a disabled-with-reason entry for a user unload (bucket boundary)", async () => {
      const host = createHost([createExtension("voluntary")], deps);
      await host.activate();

      await host.unloadExtension("voluntary");
      expect(host.getDisabled()).toHaveLength(0);
      expect(host.getExtensions()).toHaveLength(0);
    });

    it("a properly-disposing deactivate produces no dangling registrations", async () => {
      const handle = defineService<string>("clean/svc");
      const job: ScheduledJob = { id: "clean-job", cron: "* * * * *", execute: () => {} };
      let schedulerApi: HostAPI["scheduler"] | undefined;
      let unprovide: (() => void) | undefined;

      const clean = createExtension("clean", {
        activate: (host) => {
          schedulerApi = host.scheduler;
          unprovide = host.provideService(handle, "impl");
          schedulerApi.register(job);
        },
        deactivate: () => {
          unprovide?.();
          schedulerApi?.unregister("clean-job");
        },
      });

      const host = createHost([clean], deps);
      await host.activate();

      const result = await host.unloadExtension("clean");
      expect(result.ok).toBe(true);
      expect(result.dangling).toBeUndefined();
      expect(scheduler.unregistered).toContain("clean-job");
      expect(() => deps.bus.getService(handle)).toThrow();
    });
  });

  describe("reloadExtension", () => {
    it("swaps in a new instance for the same id: old registrations gone, new present", async () => {
      const v1 = createFakeTool("tool-v1");
      const v2 = createFakeTool("tool-v2");
      const oldExt = createExtension("swappable", {
        activate: (host) => {
          host.defineTool(v1);
        },
      });
      const newExt = createExtension("swappable", {
        activate: (host) => {
          host.defineTool(v2);
        },
      });

      const host = createHost([oldExt], deps);
      await host.activate();

      const result = await host.reloadExtension("swappable", newExt);

      expect(result.ok).toBe(true);
      expect(result.manifest?.id).toBe("swappable");
      expect(host.getTool("tool-v1")).toBeUndefined();
      expect(host.getTool("tool-v2")).toBe(v2);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["swappable"]);
    });

    it("deactivates the old instance during reload", async () => {
      const calls: string[] = [];
      const oldExt = createExtension("swappable", {
        activate: () => {
          calls.push("activate-old");
        },
        deactivate: () => {
          calls.push("deactivate-old");
        },
      });
      const newExt = createExtension("swappable", {
        activate: () => {
          calls.push("activate-new");
        },
      });

      const host = createHost([oldExt], deps);
      await host.activate();
      await host.reloadExtension("swappable", newExt);

      expect(calls).toEqual(["activate-old", "deactivate-old", "activate-new"]);
    });

    it("refuses while loaded dependents exist, returning the dependent list", async () => {
      const oldExt = createExtension("base");
      const dependent = createExtension("dependent", { dependsOn: ["base"] });
      const newExt = createExtension("base");
      const host = createHost([oldExt, dependent], deps);
      await host.activate();

      const result = await host.reloadExtension("base", newExt);

      expect(result.ok).toBe(false);
      expect(result.blockedBy).toEqual(["dependent"]);
      // untouched
      expect(host.getExtensions().map((m) => m.id)).toEqual(["base", "dependent"]);
    });

    it("force reload cascades: unloads dependents, reloads target, reloads dependents", async () => {
      const order: string[] = [];
      const mkExt = (id: string, depsOn?: readonly string[]) =>
        createExtension(id, {
          dependsOn: depsOn,
          activate: () => {
            order.push(`activate-${id}`);
          },
          deactivate: () => {
            order.push(`deactivate-${id}`);
          },
        });
      const baseV1 = mkExt("base");
      const dependent = mkExt("dependent", ["base"]);
      const baseV2 = createExtension("base", {
        activate: () => {
          order.push("activate-base-v2");
        },
      });

      const host = createHost([baseV1, dependent], deps);
      await host.activate();
      order.length = 0;

      const result = await host.reloadExtension("base", baseV2, { force: true });

      expect(result.ok).toBe(true);
      expect(result.unloadedDependents).toEqual(["dependent"]);
      expect(result.reloadedDependents).toEqual(["dependent"]);
      // reverse-topo unload (dependent first, then the target's own
      // deactivate), target swap, then the dependent back
      expect(order).toEqual([
        "deactivate-dependent",
        "deactivate-base",
        "activate-base-v2",
        "activate-dependent",
      ]);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["base", "dependent"]);
    });

    it("a reload of new incompatible code lands in disabled-with-reason (uniform grammar)", async () => {
      const oldExt = createExtension("swappable");
      const newExt = createExtension("swappable", { apiVersion: "^99.0.0" });
      const host = createHost([oldExt], deps);
      await host.activate();

      const result = await host.reloadExtension("swappable", newExt);

      expect(result.ok).toBe(false);
      expect(result.disabled?.reason).toContain("incompatible");
      expect(host.getDisabled().some((d) => d.manifest.id === "swappable")).toBe(true);
      expect(host.getExtensions()).toHaveLength(0);
    });

    it("refuses a manifest id mismatch", async () => {
      const host = createHost([createExtension("a")], deps);
      await host.activate();

      const result = await host.reloadExtension("a", createExtension("b"));
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("mismatch");
    });

    it("degenerates to a plain load when the id is not currently loaded", async () => {
      const host = createHost([], deps);
      await host.activate();

      const result = await host.reloadExtension("fresh", createExtension("fresh"));
      expect(result.ok).toBe(true);
      expect(host.getExtensions().map((m) => m.id)).toEqual(["fresh"]);
    });

    it("a failed dependent reload after force cascade lands in disabled-with-reason", async () => {
      // The dependent's activate throws on its SECOND invocation (the
      // cascade reload) → disabled-with-reason; the reloaded base stays up.
      let activateCount = 0;
      const oldBase = createExtension("base");
      const oldDependent = createExtension("dependent", {
        dependsOn: ["base"],
        activate: () => {
          activateCount++;
          if (activateCount >= 2) throw new Error("new code boom");
        },
      });

      const host = createHost([oldBase, oldDependent], deps);
      await host.activate();

      const result = await host.reloadExtension("base", createExtension("base"), {
        force: true,
      });

      expect(result.ok).toBe(true); // base itself reloaded fine
      expect(result.reloadedDependents).toBeUndefined();
      expect(host.getExtensions().map((m) => m.id)).toEqual(["base"]);
      const entry = host.getDisabled().find((d) => d.manifest.id === "dependent");
      expect(entry?.reason).toContain("new code boom");
    });
  });

  describe("live getExtensions / getDisabled", () => {
    it("reflect runtime state across load and unload", async () => {
      const host = createHost([createExtension("boot")], deps);
      await host.activate();
      expect(host.getExtensions().map((m) => m.id)).toEqual(["boot"]);

      await host.loadExtension(createExtension("runtime"));
      expect(host.getExtensions().map((m) => m.id)).toEqual(["boot", "runtime"]);

      await host.unloadExtension("boot");
      expect(host.getExtensions().map((m) => m.id)).toEqual(["runtime"]);

      await host.unloadExtension("runtime");
      expect(host.getExtensions()).toHaveLength(0);
    });

    it("getDisabled reflects runtime load failures, live", async () => {
      const host = createHost([], deps);
      await host.activate();
      expect(host.getDisabled()).toHaveLength(0);

      await host.loadExtension(createExtension("old", { apiVersion: "^99.0.0" }));
      expect(host.getDisabled()).toHaveLength(1);
      expect(host.getDisabled()[0]?.manifest.id).toBe("old");
    });
  });

  describe("host-level provideService disposer", () => {
    it("un-providing via the disposer makes getService throw again", async () => {
      const handle = defineService<string>("disposer/svc");
      const ext = createExtension("disposer", {
        activate: (host) => {
          const unprovide = host.provideService(handle, "impl");
          unprovide();
        },
      });

      const host = createHost([ext], deps);
      await host.activate();

      expect(() => deps.bus.getService(handle)).toThrow(/no provider/);
    });

    it("unload after an extension disposed its own service leaves nothing dangling", async () => {
      const handle = defineService<string>("tidy/svc");
      let unprovide: (() => void) | undefined;
      const ext = createExtension("tidy", {
        activate: (host) => {
          unprovide = host.provideService(handle, "impl");
        },
        deactivate: () => {
          unprovide?.();
        },
      });

      const host = createHost([ext], deps);
      await host.activate();
      const result = await host.unloadExtension("tidy");

      expect(result.ok).toBe(true);
      expect(result.dangling).toBeUndefined();
      expect(() => deps.bus.getService(handle)).toThrow();
    });
  });

  describe("scheduler unregister", () => {
    it("unregisters a job from the host list and the injected scheduler", async () => {
      const job: ScheduledJob = { id: "temp-job", cron: "* * * * *", execute: () => {} };
      let schedulerApi: HostAPI["scheduler"] | undefined;
      const ext = createExtension("job-owner", {
        activate: (host) => {
          schedulerApi = host.scheduler;
          schedulerApi.register(job);
        },
      });

      const host = createHost([ext], deps);
      await host.activate();
      expect(host.getScheduledJobs()).toHaveLength(1);
      expect(scheduler.jobs).toHaveLength(1);

      schedulerApi?.unregister("temp-job");

      expect(host.getScheduledJobs()).toHaveLength(0);
      expect(scheduler.jobs).toHaveLength(0);
      expect(scheduler.unregistered).toEqual(["temp-job"]);
    });

    it("unload unregisters remaining jobs even without an explicit unregister", async () => {
      const job: ScheduledJob = { id: "orphan-job", cron: "* * * * *", execute: () => {} };
      const ext = createExtension("job-leaver", {
        activate: (host) => {
          host.scheduler.register(job);
        },
      });

      const host = createHost([ext], deps);
      await host.activate();
      const result = await host.unloadExtension("job-leaver");

      expect(result.ok).toBe(true);
      expect(host.getScheduledJobs()).toHaveLength(0);
      expect(scheduler.unregistered).toContain("orphan-job");
      expect(result.dangling).toEqual([{ kind: "job", id: "orphan-job" }]);
    });
  });
});
