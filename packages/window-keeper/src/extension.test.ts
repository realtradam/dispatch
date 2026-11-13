import type { AccountUsageService } from "@dispatch/account-usage";
import {
  createLogger,
  type HostAPI,
  type LogLineRecord,
  type LogRecord,
  type ProviderContract,
  type ProviderEvent,
  type ProviderResponseHeadersPayload,
  providerResponseHeaders,
  type ServiceHandle,
} from "@dispatch/kernel";
import type { AccountUsageProviderId, AccountUsageReport } from "@dispatch/transport-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageFromMap } from "../../kernel/src/host/storage.test-support.js";
import { BOOT_DELAY_MS, UNKNOWN_RECHECK_MS } from "./core.js";
import { deactivate, extension } from "./extension.js";
import {
  WINDOW_KEEPER_SETTINGS_KEY,
  type WindowKeeperService,
  windowKeeperServiceHandle,
} from "./settings.js";

const BASE = Date.parse("2026-11-13T00:00:00Z");
const FIVE_HOURS = 5 * 3_600_000;
const CLAUDE_RESET_HEADER = "anthropic-ratelimit-unified-5h-reset";
const CODEX_RESET_AFTER_HEADER = "x-codex-primary-reset-after-seconds";

const secs = (ms: number): string => String(Math.floor(ms / 1000));

type ReportMode = "idle" | "unavailable";

const LIMIT_FOR: Record<string, string> = {
  claude: "claude:5h",
  codex: "codex:primary",
  opencode: "opencode:5h",
};

function createFakeAccountUsage(checks: string[], mode: ReportMode = "idle"): AccountUsageService {
  const get = async (provider: AccountUsageProviderId): Promise<AccountUsageReport> => {
    checks.push(provider);
    const now = Date.now();
    return {
      provider,
      label: provider,
      state: mode === "idle" ? "fresh" : "unavailable",
      account: null,
      limits:
        mode === "idle"
          ? [
              {
                id: LIMIT_FOR[provider] ?? `${provider}:primary`,
                label: provider,
                kind: "window",
                windowId: "5h",
                shared: true,
                tier: null,
                durationMs: FIVE_HOURS,
                resetsAt: null,
                unit: "percent",
                used: 0,
                limit: 100,
                remaining: 100,
                usedFraction: 0,
                remainingFraction: 1,
                status: "ok",
              },
            ]
          : [],
      limitReached: null,
      canServe: null,
      creditOverage: false,
      credits: null,
      fetchedAt: now,
      lastAttemptAt: now,
      nextRefreshAt: now + 300_000,
      error: null,
    };
  };
  return {
    get: get as AccountUsageService["get"],
    getAll: async () => ({ providers: [], servedAt: Date.now() }),
    ingestHeaders: () => {},
  };
}

interface StreamCall {
  readonly messages: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly opts?: Record<string, unknown>;
}

function createFakeProvider(
  id: string,
  calls: StreamCall[],
  models?: readonly string[],
): ProviderContract {
  const provider: ProviderContract = {
    id,
    stream: async function* stream(messages, tools, opts): AsyncIterable<ProviderEvent> {
      calls.push({ messages, tools, opts: opts as unknown as Record<string, unknown> });
      yield { type: "finish", reason: "stop" };
    },
  };
  if (models !== undefined) {
    return {
      ...provider,
      listModels: async () => models.map((modelId) => ({ id: modelId })),
    };
  }
  return provider;
}

interface FakeHost {
  readonly host: HostAPI;
  readonly services: Map<string, unknown>;
  readonly headerHandlers: Set<(payload: ProviderResponseHeadersPayload) => void>;
  readonly records: LogRecord[];
  readonly subscriptionDisposed: () => boolean;
  readonly emitHeaders: (payload: ProviderResponseHeadersPayload) => void;
}

function createFakeHost(options: {
  providers?: ReadonlyMap<string, ProviderContract>;
  accountUsage?: AccountUsageService;
  storageData?: Map<string, string>;
}): FakeHost {
  const services = new Map<string, unknown>();
  if (options.accountUsage !== undefined) {
    services.set("account-usage/service", options.accountUsage);
  }
  const headerHandlers = new Set<(payload: ProviderResponseHeadersPayload) => void>();
  const records: LogRecord[] = [];
  let subscriptionDisposed = false;
  const logger = createLogger(
    { extensionId: "host" },
    { emit: (record) => records.push(record) },
    { now: () => Date.now(), newId: () => "test" },
  );
  const storageData = options.storageData ?? new Map<string, string>();
  const providerMap = options.providers ?? new Map<string, ProviderContract>();

  const host = {
    logger,
    getProviders: () => providerMap,
    tryGetService<T>(handle: ServiceHandle<T>): T | undefined {
      return services.get(handle.id) as T | undefined;
    },
    getService<T>(handle: ServiceHandle<T>): T {
      const impl = services.get(handle.id);
      if (impl === undefined) throw new Error(`no provider for ${handle.id}`);
      return impl as T;
    },
    provideService<T>(handle: ServiceHandle<T>, impl: T): () => void {
      services.set(handle.id, impl);
      return () => {
        services.delete(handle.id);
      };
    },
    storage: () => storageFromMap(storageData),
    on<TPayload>(hook: { readonly id: string }, handler: (payload: TPayload) => void): () => void {
      if (hook.id !== providerResponseHeaders.id) return () => {};
      const typed = handler as unknown as (payload: ProviderResponseHeadersPayload) => void;
      headerHandlers.add(typed);
      return () => {
        subscriptionDisposed = true;
        headerHandlers.delete(typed);
      };
    },
  } as unknown as HostAPI;

  return {
    host,
    services,
    headerHandlers,
    records,
    subscriptionDisposed: () => subscriptionDisposed,
    emitHeaders: (payload) => {
      for (const handler of headerHandlers) handler(payload);
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function warnLogs(records: LogRecord[]): LogLineRecord[] {
  return records.filter(
    (record): record is LogLineRecord => record.kind === "log" && record.level === "warn",
  );
}

function serviceOf(fake: FakeHost): WindowKeeperService {
  const service = fake.services.get(windowKeeperServiceHandle.id);
  if (service === undefined) throw new Error("window-keeper service not provided");
  return service as WindowKeeperService;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  deactivate();
  vi.useRealTimers();
});

describe("window-keeper extension", () => {
  it("starts both keepers by default and streams with each profile's options", async () => {
    const claudeCalls: StreamCall[] = [];
    const codexCalls: StreamCall[] = [];
    const providers = new Map<string, ProviderContract>([
      [
        "anthropic",
        createFakeProvider("anthropic", claudeCalls, ["claude-sonnet-4", "claude-haiku-4-5"]),
      ],
      ["openai", createFakeProvider("openai", codexCalls)],
    ]);
    const fake = createFakeHost({ providers, accountUsage: createFakeAccountUsage([]) });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();

    expect(claudeCalls).toHaveLength(1);
    expect(codexCalls).toHaveLength(1);

    const claude = claudeCalls[0];
    if (claude === undefined) throw new Error("no Claude kick");
    expect(claude.messages).toHaveLength(1);
    expect(claude.messages[0]).toEqual({ role: "user", chunks: [{ type: "text", text: "hi" }] });
    expect(claude.tools).toEqual([]);
    expect(claude.opts).toMatchObject({ maxTokens: 1, model: "claude-haiku-4-5" });
    expect(claude.opts?.signal).toBeInstanceOf(AbortSignal);

    const codex = codexCalls[0];
    if (codex === undefined) throw new Error("no Codex kick");
    expect(codex.opts).toMatchObject({
      reasoningEffort: "low",
      systemPrompt: "Reply with the single word OK.",
    });
    expect(codex.opts?.model).toBeUndefined();
    expect(codex.opts?.maxTokens).toBeUndefined();
  });

  it("leaves the Claude keeper stopped when settings persist { claude: false }", async () => {
    const checks: string[] = [];
    const storageData = new Map<string, string>([
      [WINDOW_KEEPER_SETTINGS_KEY, JSON.stringify({ claude: false, codex: true })],
    ]);
    const fake = createFakeHost({
      accountUsage: createFakeAccountUsage(checks, "unavailable"),
      storageData,
    });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();

    expect(checks).toEqual(["codex"]);
  });

  it("setEnabled through the provided service starts and stops the right keeper", async () => {
    const checks: string[] = [];
    const fake = createFakeHost({ accountUsage: createFakeAccountUsage(checks, "unavailable") });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();
    expect(checks.sort()).toEqual(["claude", "codex"]);

    const service = serviceOf(fake);
    expect(await service.setEnabled({ provider: "claude", enabled: false })).toMatchObject({
      ok: true,
    });
    await flush();

    await vi.advanceTimersByTimeAsync(UNKNOWN_RECHECK_MS);
    await flush();
    expect(checks.filter((id) => id === "claude")).toHaveLength(1);
    expect(checks.filter((id) => id === "codex")).toHaveLength(2);

    expect(await service.setEnabled({ provider: "claude", enabled: true })).toMatchObject({
      ok: true,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();
    expect(checks.filter((id) => id === "claude")).toHaveLength(2);
  });

  it("routes response headers by authId (a Claude auth id does not reschedule Codex)", async () => {
    const checks: string[] = [];
    const fake = createFakeHost({ accountUsage: createFakeAccountUsage(checks, "unavailable") });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();
    expect(checks).toHaveLength(2);

    // The header carries a reset for BOTH profiles; routing must deliver it
    // only to the Claude keeper.
    fake.emitHeaders({
      providerId: "anthropic",
      authId: "claude-oauth",
      status: 200,
      headers: {
        [CLAUDE_RESET_HEADER]: secs(Date.now() + FIVE_HOURS),
        [CODEX_RESET_AFTER_HEADER]: String(FIVE_HOURS / 1000),
      },
    });
    await flush();

    await vi.advanceTimersByTimeAsync(UNKNOWN_RECHECK_MS);
    await flush();
    expect(checks.filter((id) => id === "claude")).toHaveLength(1);
    expect(checks.filter((id) => id === "codex")).toHaveLength(2);
  });

  it("kick returns unavailable without a provider", async () => {
    const fake = createFakeHost({ accountUsage: createFakeAccountUsage([]) });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();

    const warns = warnLogs(fake.records).filter(
      (line) => line.msg === "window-keeper: could not start a window",
    );
    expect(warns).toHaveLength(2);
    expect(warns.map((line) => line.attributes?.outcome)).toEqual(["unavailable", "unavailable"]);
  });

  it("kick returns unavailable when the provider lists no models", async () => {
    const providers = new Map<string, ProviderContract>([
      ["anthropic", createFakeProvider("anthropic", [], [])],
      ["openai", createFakeProvider("openai", [], [])],
    ]);
    const fake = createFakeHost({ providers, accountUsage: createFakeAccountUsage([]) });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();

    const warns = warnLogs(fake.records).filter(
      (line) => line.msg === "window-keeper: could not start a window",
    );
    expect(warns).toHaveLength(2);
    expect(warns.map((line) => line.attributes?.outcome)).toEqual(["unavailable", "unavailable"]);
  });

  it("deactivate disposes the service and subscription and stops both keepers", async () => {
    const checks: string[] = [];
    const fake = createFakeHost({ accountUsage: createFakeAccountUsage(checks, "unavailable") });
    extension.activate(fake.host);
    await flush();

    await vi.advanceTimersByTimeAsync(BOOT_DELAY_MS);
    await flush();
    expect(checks).toHaveLength(2);

    deactivate();

    expect(fake.services.has(windowKeeperServiceHandle.id)).toBe(false);
    expect(fake.subscriptionDisposed()).toBe(true);
    expect(fake.headerHandlers.size).toBe(0);

    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    await flush();
    expect(checks).toHaveLength(2);
  });
});
