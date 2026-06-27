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
 * Effects (filesystem, orchestrator) live here in the shell, injected into the
 * service. The pure decisions live in `pure.ts`. No `console.*`; logging via
 * `host.logger`.
 */

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve as pathResolve } from "node:path";
import { conversationStoreHandle } from "@dispatch/conversation-store";
import type { CredentialStore } from "@dispatch/credential-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import {
  createVisionHandoffService,
  orchestratorLocalHandle,
  visionHandoffHandle,
} from "./service.js";
import { createConsultVisionTool } from "./tool.js";

export const manifest: Manifest = {
  id: "vision-handoff",
  name: "Vision Handoff",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { services: ["vision-handoff/service"], tools: ["consult_vision"] },
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

export async function activate(host: HostAPI): Promise<void> {
  const credentialStore = host.getService(credentialStoreHandle) as CredentialStore | undefined;
  if (credentialStore === undefined) {
    host.logger.warn(
      "vision-handoff: credential-store service not available. The consult_vision tool and image handoff are disabled.",
    );
    return;
  }

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
    resolveOrchestrator: () => {
      const loaded = host.getExtensions().some((m) => m.id === "session-orchestrator");
      if (!loaded) return undefined;
      try {
        return host.getService(orchestratorLocalHandle);
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
    logger: host.logger.child({ extensionId: "vision-handoff" }),
  });

  host.provideService(visionHandoffHandle, service);
  host.defineTool(createConsultVisionTool(service));
  host.logger.info("vision-handoff: registered (consult_vision tool + handoff service)");
}

export const extension: Extension = { manifest, activate };
