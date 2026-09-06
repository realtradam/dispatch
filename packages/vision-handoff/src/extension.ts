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
 * Images are saved to a tmp directory (`/tmp/dispatch/images/<convId>/`) so the
 * conversation store (SQLite) only holds a compact URL reference — not
 * megabytes of base64. Tmp files are purged on reboot (ephemeral dir), after
 * compaction (the transcription replaces the image), and on conversation close.
 *
 * Effects (filesystem, orchestrator) live here in the shell, injected into the
 * service. The pure decisions live in `pure.ts`. No `console.*`; logging via
 * `host.logger`.
 */

import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { agentManagementHandle } from "@dispatch/agent-management";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import { execBackendHandle } from "@dispatch/exec-backend";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { type ToolAssembly, toolsFilter } from "@dispatch/session-orchestrator";
import { filterVisionTools } from "./pure.js";
import { createReadImageTool } from "./read-image.js";
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

const IMAGE_DIR = process.env.DISPATCH_IMAGE_DIR ?? "/tmp/dispatch/images";

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
 * Save a data URL image to a tmp file and return a compact HTTP path.
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
  const dir = join(IMAGE_DIR, conversationId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, imageId);
  const base64 = dataUrl.split(",")[1] ?? "";
  await writeFile(filePath, Buffer.from(base64, "base64"));
  return `/images/${conversationId}/${imageId}`;
}

/**
 * Resolve a compact URL (`/images/<convId>/<imageId>`) back to a data URL by
 * reading the tmp file. Data URLs and HTTP URLs pass through unchanged.
 */
async function resolveImageUrl(url: string): Promise<string> {
  if (url.startsWith("data:") || url.startsWith("http")) return url;
  if (!url.startsWith("/images/")) return url;
  const parts = url.split("/"); // ["", "images", convId, imageId]
  const convId = parts[2];
  const imageId = parts[3];
  if (convId === undefined || imageId === undefined) return url;
  const filePath = join(IMAGE_DIR, convId, imageId);
  const buf = await readFile(filePath);
  const ext = extname(imageId).toLowerCase();
  const mime = MIME_BY_EXT[ext] ?? "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Delete a single tmp image file (after compaction — best-effort). */
async function deleteTmpImage(compactUrl: string): Promise<void> {
  if (!compactUrl.startsWith("/images/")) return;
  const parts = compactUrl.split("/");
  const convId = parts[2];
  const imageId = parts[3];
  if (convId === undefined || imageId === undefined) return;
  const filePath = join(IMAGE_DIR, convId, imageId);
  try {
    await unlink(filePath);
  } catch {
    // Best-effort — file may already be deleted.
  }
}

/** Delete all tmp images for a conversation (on close — best-effort). */
async function deleteConversationImages(conversationId: string): Promise<void> {
  const dir = join(IMAGE_DIR, conversationId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort.
  }
}

export async function activate(host: HostAPI): Promise<void> {
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

  const service = createVisionHandoffService({
    credentialStore,
    resolveModel,
    readFileAsDataUrl,
    saveImageToTmp,
    resolveImageUrl,
    deleteTmpImage,
    deleteConversationImages,
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
    getImageTranscriptions: async (conversationId: string) => {
      const store = host.getService(conversationStoreHandle);
      return store.getImageTranscriptions(conversationId);
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

  host.provideService(visionHandoffHandle, service);
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
  host.addFilter(toolsFilter, async (assembly: ToolAssembly): Promise<ToolAssembly> => {
    const capable = await service.isVisionCapable(assembly.modelName);
    const tools = filterVisionTools(assembly.tools, capable);
    return { ...assembly, tools };
  });

  host.logger.info(
    "vision-handoff: registered (consult_vision + read_image tools, handoff service, model-aware tools filter)",
  );
}

export const extension: Extension = { manifest, activate };
