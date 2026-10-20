/** Disposable real-route / real-frontend cold boot; never boots the application host. */
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import {
  createConversationStore,
  initializeConversationListIndex,
} from "../packages/conversation-store/dist/index.js";
import { createCredentialStore } from "../packages/credential-store/dist/index.js";
import { runTurn } from "../packages/kernel/dist/index.js";
import { createSessionOrchestrator } from "../packages/session-orchestrator/dist/index.js";
import { createSqliteStorage } from "../packages/storage-sqlite/dist/index.js";
import { createApp } from "../packages/transport-http/dist/index.js";
import { guardUpgrade } from "../packages/transport-ws/dist/extension.js";

const root = await mkdtemp(resolve(tmpdir(), "review-7.8-timing-"));
const source = resolve(process.argv[2] ?? "/tmp/review-db/dispatch.db");
assert(source.startsWith("/tmp/review-db/"), "Only the pre-existing snapshot is permitted");
for (const port of [34203, 34204, 34205]) {
  const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  probe.stop(true);
}
// Duplicate the quiescent pre-existing snapshot plus WAL/SHM before SQLite opens it.
const copy = resolve(root, "dispatch.db");
for (const suffix of ["", "-wal", "-shm"]) await copyFile(source + suffix, copy + suffix);
const duplicate = new Database(copy, { readonly: true });
duplicate.exec("PRAGMA query_only=ON");
assert.equal(
  duplicate.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check,
  "ok",
);
duplicate.close();
const storage = createSqliteStorage({ path: copy });
const namespace = storage.storage("conversation-store");
const snapshotRows = await namespace.count("");
const initStart = performance.now();
await initializeConversationListIndex(namespace);
const initMs = performance.now() - initStart;
const store = createConversationStore(namespace);
const open = await store.listConversations({ status: ["active", "idle"] });
const workspaces = await store.listWorkspaces();
const provider = {
  id: "fixture",
  async *stream() {
    yield { type: "finish" as const, reason: "stop" };
  },
};
const { orchestrator } = createSessionOrchestrator({
  conversationStore: store,
  resolveProvider: () => provider,
  resolveTools: () => [],
  runTurn,
  applyToolsFilter: async (a) => a,
});
const app = createApp({
  conversationStore: store,
  orchestrator,
  credentialStore: createCredentialStore({ credentials: [], getProvider: () => undefined }),
});
const requests: { path: string; status: number; ms: number }[] = [];
let subscriptions = 0;
const http = Bun.serve({
  hostname: "127.0.0.1",
  port: 34203,
  async fetch(req) {
    const start = performance.now();
    const response = await app.fetch(req);
    requests.push({
      path: new URL(req.url).pathname + new URL(req.url).search,
      status: response.status,
      ms: performance.now() - start,
    });
    return response;
  },
});
process.on("exit", () => {
  http.stop(true);
  storage.close();
});
const ws = Bun.serve({
  hostname: "127.0.0.1",
  port: 34205,
  fetch(req, server) {
    const rejected = guardUpgrade(req, new Set(["localhost", "127.0.0.1", "::1"]));
    if (rejected) return rejected;
    if (new URL(req.url).pathname === "/health") return new Response("ok");
    if (server.upgrade(req)) return;
    return new Response("upgrade required", { status: 400 });
  },
  websocket: {
    open(socket) {
      socket.send(JSON.stringify({ type: "catalog", surfaces: [] }));
    },
    message(_socket, data) {
      if (JSON.parse(String(data)).type === "chat.subscribe") subscriptions++;
    },
  },
});
process.on("exit", () => ws.stop(true));
const web = resolve(root, "web");
await mkdir(web);
const build = Bun.spawn(["bun", "run", "build", "--outDir", web], {
  cwd: resolve("../frontend"),
  env: {
    ...process.env,
    NODE_OPTIONS: "--no-experimental-webstorage",
    VITE_HTTP_PORT: "34203",
    VITE_WS_PORT: "34205",
  },
  stdout: Bun.file(resolve(root, "build.log")),
  stderr: Bun.file(resolve(root, "build.err")),
});
assert.equal(await build.exited, 0, "temporary frontend build");
const frontend = Bun.serve({
  hostname: "127.0.0.1",
  port: 34204,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(resolve(web, `.${path}`));
    return new Response((await file.exists()) ? file : Bun.file(resolve(web, "index.html")));
  },
});
process.on("exit", () => frontend.stop(true));
// CDP uses inherited pipes: no additional TCP/debug listener and no package installation.
const browser = spawn(
  "chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
    "--remote-debugging-pipe",
    `--user-data-dir=${root}/profile`,
  ],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
);
process.on("exit", () => browser.kill("SIGTERM"));
const input = browser.stdio[3];
const output = browser.stdio[4];
assert(input && "write" in input && output);
let id = 0;
const pending = new Map<
  number,
  { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
>();
let wire = "";
const violations: string[] = [];
const errors: unknown[] = [];
const browserRequests: string[] = [];
let sessionId: string;
function command(
  method: string,
  params = {},
  session = sessionId,
): Promise<Record<string, unknown>> {
  const key = ++id;
  return new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(key)) reject(new Error(`CDP timeout: ${method}`));
    }, 15000).unref();
    (input as Writable).write(
      `${JSON.stringify({ id: key, method, params, ...(session ? { sessionId: session } : {}) })}\0`,
    );
  });
}
output.on("data", (chunk) => {
  wire += chunk.toString();
  for (let end = wire.indexOf("\0"); end >= 0; end = wire.indexOf("\0")) {
    const message = JSON.parse(wire.slice(0, end));
    wire = wire.slice(end + 1);
    if (message.id) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
      else waiter?.resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
    if (message.method === "Fetch.requestPaused") {
      const { requestId, request } = message.params;
      const url = new URL(request.url);
      const allowed =
        url.hostname === "127.0.0.1" && ["34203", "34204", "34205"].includes(url.port);
      browserRequests.push(request.url);
      if (!allowed) violations.push(request.url);
      void command(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed ? { requestId } : { requestId, errorReason: "BlockedByClient" },
      );
    }
  }
});
async function evaluate(expression: string) {
  const result = await command("Runtime.evaluate", { expression, returnByValue: true });
  return (result.result as { value?: unknown })?.value;
}
try {
  const security = [];
  for (const [path, method, headers, expected] of [
    ["/conversations/..%2F..%2Fthrowaway/close", "POST", {}, 400],
    ["/images/..%2F..%2Fetc/passwd", "GET", {}, 400],
    ["/health", "GET", { Host: "evil.com" }, 421],
    ["/health", "GET", { Origin: "https://evil.com" }, 403],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:34203${path}`, {
      method,
      headers: new Headers(headers as HeadersInit),
    });
    assert.equal(response.status, expected);
    security.push({ path, status: response.status });
  }
  for (const headers of [{ Host: "evil.com" }, { Origin: "https://evil.com" }] as Record<
    string,
    string
  >[]) {
    const response = await fetch("http://127.0.0.1:34205/health", {
      headers: new Headers(headers as HeadersInit),
    });
    assert.equal(response.status, "Host" in headers ? 421 : 403);
    security.push({ port: 34205, status: response.status });
  }
  const target = await command("Target.createTarget", { url: "about:blank" });
  const attached = await command("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  sessionId = attached.sessionId as string;
  await command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await command("Network.enable");
  await command("Network.setCacheDisabled", { cacheDisabled: true });
  await command("Page.enable");
  await command("Runtime.enable");
  await command("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const measurements = [];
  const tabs = open.map((c) => ({
    conversationId: c.id,
    model: "",
    title: "Copied conversation",
    workspaceId: c.workspaceId,
  }));
  const active = open.find((c) => c.id === "04515283-da23-4d1f-85ef-f0b8518a1640");
  assert(active);
  for (const [path, activeId] of [
    ["/", null],
    ["/", active.id],
    [`/${active.workspaceId}`, active.id],
  ] as const) {
    const seed = JSON.stringify({ tabs, activeConversationId: activeId });
    const injected = await command("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("dispatch.tabs", ${JSON.stringify(seed)});`,
    });
    requests.length = 0;
    browserRequests.length = 0;
    subscriptions = 0;
    const start = performance.now();
    await command("Page.navigate", { url: `http://127.0.0.1:34204${path}` });
    let homeTilesObservedMs: number | null = null;
    if (path === "/") {
      for (let poll = 0; poll < 50; poll++) {
        if (await evaluate("document.body.innerText.toLowerCase().includes('aviationgse')")) {
          homeTilesObservedMs = performance.now() - start;
          break;
        }
        await Bun.sleep(100);
      }
      assert(
        homeTilesObservedMs !== null,
        `home workspace tiles rendered: ${String(await evaluate("document.body.innerText")).slice(0, 1200)}`,
      );
    }
    await Bun.sleep(Math.max(0, 5000 - (performance.now() - start)));
    measurements.push({
      homeTilesObservedMs,
      path,
      activeRestored: activeId !== null,
      paintTiming: await evaluate(
        "performance.getEntriesByType('paint').map(x=>({name:x.name,ms:x.startTime}))",
      ),
      observationMs: performance.now() - start,
      requests: [...requests],
      browserRequestCount: browserRequests.length,
      subscriptions,
      rendered: Boolean(await evaluate("document.body.innerText.includes('Dispatch')")),

      resourceTiming: await evaluate(
        "performance.getEntriesByType('resource').filter(x=>x.name.includes(':34203')).map(x=>({url:x.name,duration:x.duration,responseEnd:x.responseEnd}))",
      ),
    });
    await command("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
    assert.equal(
      requests.filter((r) => /^\/conversations\/[^/]+\?/.test(r.path)).length,
      activeId ? 1 : 0,
    );
    assert.equal(requests.filter((r) => r.path.endsWith("/metrics")).length, activeId ? 1 : 0);
    await command("Storage.clearDataForOrigin", {
      origin: "http://127.0.0.1:34204",
      storageTypes: "all",
    });
  }
  const readStart = performance.now();
  for (const conversation of open) {
    await store.loadSince(conversation.id, 0, { limit: 192 });
    await store.loadMetrics(conversation.id);
  }
  const eagerReadProxyMs = performance.now() - readStart;
  assert.equal(violations.length, 0, "no request outside permitted alternate listeners");
  assert.equal(errors.length, 0, "frontend runtime errors");
  const listeners = await new Response(
    Bun.spawn(["ss", "-ltn", "( sport = :34203 or sport = :34204 or sport = :34205 )"], {
      stdout: "pipe",
    }).stdout,
  ).text();
  console.log(
    JSON.stringify(
      {
        root,
        source,
        copy,
        initMs,
        snapshotRows,
        eagerReadProxyMs,
        openConversations: open.length,
        workspaces: workspaces.length,
        security,
        listeners,
        measurements,
        violations,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await command("Browser.close").catch(() => {});
  browser.kill("SIGTERM");
  frontend.stop(true);
  ws.stop(true);
  http.stop(true);
  storage.close();
}
