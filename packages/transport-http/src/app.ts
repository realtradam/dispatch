import type { Logger } from "@dispatch/kernel";
import { buildAllowedHosts, checkHost, checkOrigin, corsOriginFor } from "@dispatch/network-policy";
import { parseConversationId } from "@dispatch/transport-contract";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { RouteOptions } from "./route-options.js";
import { mount as mountChat } from "./routes/chat.js";
import { mount as mountCompaction } from "./routes/compaction.js";
import { mount as mountComputers } from "./routes/computers.js";
import { mount as mountConcurrency } from "./routes/concurrency.js";
import { mount as mountConversationHistory } from "./routes/conversation-history.js";
import { mount as mountConversationQueue } from "./routes/conversation-queue.js";
import { mount as mountConversationServers } from "./routes/conversation-servers.js";
import { mount as mountConversationSettings } from "./routes/conversation-settings.js";
import { mount as mountConversations } from "./routes/conversations.js";
import { mount as mountHeartbeat } from "./routes/heartbeat.js";
import { mount as mountHomeTileLayout } from "./routes/home-tile-layout.js";
import { mount as mountImages } from "./routes/images.js";
import { mount as mountLayout } from "./routes/layout.js";
import { mount as mountModels } from "./routes/models.js";
import { mount as mountNamedAgents } from "./routes/named-agents.js";
import { mount as mountPlugins } from "./routes/plugins.js";
import { mount as mountSearch } from "./routes/search.js";
import { mount as mountSettings } from "./routes/settings.js";
import { mount as mountStatic } from "./routes/static.js";
import { mount as mountTextFiles } from "./routes/text-files.js";
import { mount as mountThroughput } from "./routes/throughput.js";
import { mount as mountUsage } from "./routes/usage.js";
import { mount as mountWorkspacePlugins } from "./routes/workspace-plugins.js";
import { mount as mountWorkspaces } from "./routes/workspaces.js";
import type { CreateServerOptions } from "./server-options.js";

export { retainThroughputEvent } from "./routes/chat.js";
export type { CreateServerOptions } from "./server-options.js";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
  span() {
    return {
      id: "noop-span",
      log: noopLogger,
      setAttributes() {},
      addLink() {},
      child() {
        return this;
      },
      end() {},
    };
  },
};

export function createApp(opts: CreateServerOptions): Hono {
  const app = new Hono();
  const log = opts.logger ?? noopLogger;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => Date.now());

  const routes: RouteOptions = { config: opts, log, generateId, now };

  // Outermost so even Host/Origin and conversation-ID rejection responses are
  // non-cacheable. No file content is ever served through the SPA fallback.
  app.use("/conversations/:id/*", async (c, next) => {
    if (c.req.path.endsWith("/text-file") || c.req.path.endsWith("/text-file-context")) {
      c.header("Cache-Control", "no-store");
    }
    await next();
  });

  const allowed = opts.allowedHosts ?? buildAllowedHosts({ env: {} });
  app.use("*", async (c, next) => {
    const host = checkHost(c.req.header("host") ?? new URL(c.req.url).host, allowed);
    if (host !== "ok") return c.json({ error: host.reason }, host.status);
    const origin = checkOrigin(c.req.header("origin"), allowed);
    if (origin !== "ok") return c.json({ error: origin.reason }, origin.status);
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) => corsOriginFor(origin, allowed),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // Register before handlers; cover both the root ID route and every descendant.
  const validateConversationParam: MiddlewareHandler = async (c, next) => {
    const parsed = parseConversationId(c.req.param("id") ?? c.req.param("conversationId"));
    if (typeof parsed !== "string") return c.json(parsed, 400);
    await next();
  };
  app.use("/conversations/:id", validateConversationParam);
  app.use("/conversations/:id/*", validateConversationParam);
  app.use("/images/:conversationId/:imageId", validateConversationParam);

  app.get("/health", (c) => c.json({ ok: true }));

  mountImages(app, routes);
  mountTextFiles(app, routes);
  mountConversationHistory(app, routes);
  mountModels(app, routes);
  mountUsage(app, routes);
  mountNamedAgents(app, routes);
  mountComputers(app, routes);
  mountChat(app, routes);
  mountThroughput(app, routes);
  mountConcurrency(app, routes);
  mountConversationQueue(app, routes);
  mountConversationSettings(app, routes);
  mountConversationServers(app, routes);
  mountConversations(app, routes);
  mountCompaction(app, routes);
  mountWorkspaces(app, routes);
  mountWorkspacePlugins(app, routes);
  mountLayout(app, routes);
  mountHomeTileLayout(app, routes);
  mountHeartbeat(app, routes);
  mountSearch(app, routes);
  mountPlugins(app, routes);
  mountSettings(app, routes);
  mountStatic(app, routes);

  return app;
}
