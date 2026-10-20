/**
 * vision-handoff extension — registers the universal vision handoff service +
 * the `consult_vision` tool.
 *
 * The service performs provider-agnostic vision handoff: when a non-vision model
 * (e.g. glm-5.2) receives an image, it replaces the image with a numbered
 * placeholder and registers it for tool access. The `consult_vision` tool opens
 * a NEW conversation tab with a vision-capable model (e.g. Kimi), attaches the
 * image + the model's specific question, and returns the conversation ID + the
 * vision model's answer. Follow-ups go through the dispatch CLI.
 *
 * Images live in the data directory, with compact URLs persisted in SQLite.
 * Age-based retention bounds disk use; closing a conversation preserves images.
 *
 * Effects (filesystem, orchestrator) live here in the shell, injected into the
 * service. The pure decisions live in `pure.ts`. No `console.*`; logging via
 * `host.logger`.
 */

import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { extname, isAbsolute, resolve as pathResolve, sep } from "node:path";
import { agentManagementHandle } from "@dispatch/agent-management";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import { execBackendHandle } from "@dispatch/exec-backend";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { type ToolAssembly, toolsFilter } from "@dispatch/session-orchestrator";
import { filterVisionTools } from "./pure.js";
import { createReadImageTool } from "./read-image.js";
import { selectExpired } from "./retention.js";
import { createVisionHandoffService, visionHandoffHandle } from "./service.js";
import { createConsultVisionTool } from "./tool.js";

export const manifest: Manifest = {
  id: "vision-handoff",
  name: "Vision Handoff",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  tier: "standard",
  trust: "bundled",
  // Resolved at activate time (see activate below) — the DAG must order
  // credential-store first or activation fails (getService throws when the
  // service is absent).
  dependsOn: ["credential-store"],
  activation: "eager",
  capabilities: { network: true, fs: true },
  contributes: {
    services: ["vision-handoff/service"],
    tools: ["consult_vision", "read_image"],
  },
};

/** MIME types for recognized image extensions. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** Reverse: MIME → extension. */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
};

/**
 * Read an image file from disk as a base64 data URL. Resolves relative paths
 * against the cwd (the conversation's working directory). Throws on missing
 * file / read error (the caller surfaces it). The shell edge — real `node:fs`.
 */
async function readFileAsDataUrl(path: string, cwd?: string): Promise<string> {
  const abs = cwd !== undefined && !isAbsolute(path) ? pathResolve(cwd, path) : pathResolve(path);
  const buf = await readFile(abs);
  const ext = extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Lexical containment only (no filesystem I/O). Callers pass decoded segments;
 * reject percent escapes rather than risk interpreting encoded traversal later.
 * This does not resolve symlinks; the image directory must be application-owned.
 */
export function containedPath(root: string, ...segments: string[]): string | null {
  if (segments.some((segment) => segment.includes("%") || segment.includes("\0"))) return null;
  const base = pathResolve(root);
  const path = pathResolve(base, ...segments);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return path === base || path.startsWith(prefix) ? path : null;
}

/** Bind filesystem effects to an explicit image root (also isolates tests). */
export function createImageFileStore(imageDir: string) {
  const root = pathResolve(imageDir);
  const requirePath = (base: string, ...segments: string[]): string => {
    const path = containedPath(base, ...segments);
    if (path === null) throw new Error("Invalid image path");
    return path;
  };
  const conversationPath = (conversationId: string): string => {
    const dir = requirePath(root, conversationId);
    if (dir === root) throw new Error("Invalid image path");
    return dir;
  };
  const compactImagePath = (url: string) => {
    const parts = url.split("/");
    const convId = parts[2];
    const imageId = parts[3];
    if (parts.length !== 4 || !convId || !imageId) throw new Error("Invalid image path");
    return { filePath: requirePath(conversationPath(convId), imageId), imageId };
  };

  /**
   * Save a data URL image to a durable file and return a compact HTTP path.
   * The compact URL (`/images/<conversationId>/<uuid>.<ext>`) is what gets
   * persisted in the conversation store — a tiny string, not megabytes of base64.
   */
  async function saveImageToTmp(
    conversationId: string,
    dataUrl: string,
    mimeType?: string,
  ): Promise<string> {
    const mime = mimeType ?? "image/png";
    const ext = EXT_BY_MIME[mime] ?? ".png";
    const imageId = `${crypto.randomUUID()}${ext}`;
    const dir = conversationPath(conversationId);
    await mkdir(dir, { recursive: true });
    const filePath = requirePath(dir, imageId);
    const base64 = dataUrl.split(",")[1] ?? "";
    await writeFile(filePath, Buffer.from(base64, "base64"));
    return `/images/${conversationId}/${imageId}`;
  }

  /**
   * Resolve a compact URL (`/images/<convId>/<imageId>`) back to a data URL by
   * reading the stored file. Data URLs and HTTP URLs pass through unchanged.
   */
  async function resolveImageUrl(url: string): Promise<string> {
    if (url.startsWith("data:") || url.startsWith("http")) return url;
    if (!url.startsWith("/images/")) return url;
    const { filePath, imageId } = compactImagePath(url);
    const buf = await readFile(filePath);
    const ext = extname(imageId).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  /** Delete a single tmp image file (after compaction — best-effort). */
  async function deleteTmpImage(compactUrl: string): Promise<void> {
    if (!compactUrl.startsWith("/images/")) return;
    const { filePath } = compactImagePath(compactUrl);
    try {
      await unlink(filePath);
    } catch {
      // Best-effort — file may already be deleted.
    }
  }

  /** Delete all images for a deleted conversation (best-effort). */
  async function deleteConversationImages(conversationId: string): Promise<void> {
    const dir = conversationPath(conversationId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }

  // Inspect only regular image files directly inside real conversation directories.
  // Never follow symlinks or recursively traverse unknown entries.
  async function inventory(base: string) {
    const files: { path: string; mtimeMs: number; size: number; conv: string; name: string }[] = [];
    const dirs: string[] = [];
    const entries = await readdir(base, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) continue;
      const dir = requirePath(base, entry.name);
      dirs.push(dir);
      for (const image of await readdir(dir, { withFileTypes: true })) {
        if (!image.isFile() || !/^[A-Za-z0-9_-]{1,128}\.(png|jpe?g|webp|gif|bmp)$/.test(image.name))
          continue;
        const path = requirePath(dir, image.name);
        const stat = await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (stat?.isFile())
          files.push({
            path,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            conv: entry.name,
            name: image.name,
          });
      }
    }
    return { files, dirs };
  }

  async function sweep(nowMs: number, retentionDays: number) {
    const { files, dirs } = await inventory(root);
    let deleted = 0;
    let bytesFreed = 0;
    for (const file of selectExpired(files, nowMs, retentionDays)) {
      try {
        await unlink(requirePath(root, file.conv, file.name));
        deleted++;
        bytesFreed += file.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const dir of dirs) {
      await rmdir(dir).catch((error) => {
        if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
      });
    }
    return { deleted, bytesFreed };
  }

  async function migrate(legacyDir: string, nowMs: number, retentionDays: number) {
    if (pathResolve(legacyDir) === root) return;
    const { files } = await inventory(pathResolve(legacyDir));
    const expired = new Set(selectExpired(files, nowMs, retentionDays));
    for (const file of files) {
      if (expired.has(file)) continue;
      const dest = requirePath(conversationPath(file.conv), file.name);
      await mkdir(conversationPath(file.conv), { recursive: true });
      const staging = `${dest}.${crypto.randomUUID()}.migration`;
      try {
        await copyFile(file.path, staging, constants.COPYFILE_EXCL);
        await utimes(staging, file.mtimeMs / 1000, file.mtimeMs / 1000);
        // Atomic exclusive publication: never overwrite or expose a partial copy.
        await link(staging, dest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await unlink(staging).catch(() => {});
      }
    }
  }

  return {
    saveImageToTmp,
    resolveImageUrl,
    deleteTmpImage,
    deleteConversationImages,
    sweep,
    migrate,
  };
}

const defaultEffects = {
  legacyDir: "/tmp/dispatch/images",
  now: Date.now,
  schedule: (fn: () => void, intervalMs: number) => {
    const timer = setInterval(fn, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  },
};
interface Lifecycle {
  cancelTimer: (() => void) | undefined;
  maintenance: Promise<void>;
  disposers: (() => void)[];
}

/** Instance-owned lifecycle; tests inject only clock/timer and legacy-root edges. */
export function createVisionExtension(effects = defaultEffects): Extension {
  const lifecycle: Lifecycle = {
    cancelTimer: undefined,
    maintenance: Promise.resolve(),
    disposers: [],
  };
  return {
    manifest,
    activate: (host) => activateVision(host, effects, lifecycle),
    async deactivate() {
      lifecycle.cancelTimer?.();
      lifecycle.cancelTimer = undefined;
      await lifecycle.maintenance;
      for (const dispose of lifecycle.disposers.splice(0)) dispose();
    },
  };
}

async function activateVision(
  host: HostAPI,
  effects: typeof defaultEffects,
  lifecycle: Lifecycle,
): Promise<void> {
  // dependsOn: ["credential-store"] (manifest) guarantees the service exists
  // here — getService throws when absent, which fails activation and lands
  // this extension in the host's disabled-with-reason list.
  const credentialStore = host.getService(credentialStoreHandle);

  const resolveModel = (modelName: string) => {
    const resolved = credentialStore.resolve(modelName);
    if (resolved === undefined) return undefined;
    const provider = host.getProviders().get(resolved.providerId);
    if (provider === undefined) return undefined;
    return { provider, model: resolved.model };
  };

  const imageFiles = createImageFileStore(
    host.config.get<string>("vision.imageDir") ?? ".dispatch-data/images",
  );
  const retentionDays = host.config.get<number>("vision.imageRetentionDays") ?? 7;
  let migrate = true;
  const maintain = () => {
    lifecycle.maintenance = lifecycle.maintenance
      .then(async () => {
        if (migrate) {
          try {
            await imageFiles.migrate(effects.legacyDir, effects.now(), retentionDays);
            migrate = false;
          } catch (error) {
            host.logger.warn("vision-handoff: image migration failed", {
              error: String(error),
            });
          }
        }
        const summary = await imageFiles.sweep(effects.now(), retentionDays);
        host.logger.info("vision-handoff: image retention sweep", summary);
      })
      .catch((error) =>
        host.logger.warn("vision-handoff: image retention failed", { error: String(error) }),
      );
    return lifecycle.maintenance;
  };
  await maintain();
  const service = createVisionHandoffService({
    credentialStore,
    resolveModel,
    readFileAsDataUrl,
    ...imageFiles,
    // Lazily resolve the AgentManagementService — consultations are started via
    // its `summon` method (plan §11 hard isolation). Lazy so activation order
    // doesn't matter; `undefined` degrades consult_vision with an error.
    resolveAgentManagement: () => {
      const loaded = host.getExtensions().some((m) => m.id === "agent-management");
      if (!loaded) return undefined;
      try {
        return host.getService(agentManagementHandle);
      } catch {
        return undefined;
      }
    },
    getImageTranscriptions: async (conversationId: string, urls: readonly string[]) => {
      const store = host.getService(conversationStoreHandle);
      return store.getImageTranscriptions(conversationId, urls);
    },
    setImageTranscription: async (conversationId: string, url: string, text: string) => {
      const store = host.getService(conversationStoreHandle);
      await store.setImageTranscription(conversationId, url, text);
    },
    getVisionSettings: async () => {
      const store = host.getService(conversationStoreHandle);
      return store.getVisionSettings();
    },
    logger: host.logger.child({ extensionId: "vision-handoff" }),
  });

  lifecycle.disposers.push(host.provideService(visionHandoffHandle, service));
  host.defineTool(createConsultVisionTool(service));

  // read_image — advertised ONLY to vision-capable models (the filter below
  // hides it from non-vision models). Reads filesystem images into the model's
  // own context via the injected exec backend (local/remote). Resolved eagerly
  // (the exec-backend resolver is synchronous + side-effect-free — merely
  // resolving a backend opens no connection); if exec-backend is not loaded,
  // read_image is not registered (degrades gracefully — consult_vision still
  // works without it).
  try {
    const resolveBackend = host.getService(execBackendHandle);
    host.defineTool(createReadImageTool({ resolveBackend, workdir: process.cwd() }));
  } catch {
    host.logger.warn(
      "vision-handoff: exec-backend service not available — the read_image tool is disabled.",
    );
  }

  // Model-aware tools filter (plan §12): runs once per turn, hiding
  // consult_vision from vision-capable models (they see images natively) and
  // hiding read_image from non-vision models (they can't view the images it
  // returns). ModelInfo.vision is authoritative; the name heuristic is the
  // fallback (isVisionCapable). Final toolPolicy application runs AFTER this
  // filter (in session-orchestrator), so a `none`-policy consultation receives
  // neither tool regardless.
  lifecycle.disposers.push(
    host.addFilter(toolsFilter, async (assembly: ToolAssembly): Promise<ToolAssembly> => {
      const capable = await service.isVisionCapable(assembly.modelName);
      const tools = filterVisionTools(assembly.tools, capable);
      return { ...assembly, tools };
    }),
  );

  lifecycle.cancelTimer = effects.schedule(
    () => {
      void maintain();
    },
    6 * 60 * 60 * 1000,
  );
  host.logger.info(
    "vision-handoff: registered (consult_vision + read_image tools, handoff service, model-aware tools filter)",
  );
}

export const extension = createVisionExtension();
export const activate = extension.activate;
