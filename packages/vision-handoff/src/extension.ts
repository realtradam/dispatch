/**
 * vision-handoff extension — registers the universal vision handoff service +
 * the `read_image` tool.
 *
 * The service performs provider-agnostic vision handoff: it resolves a
 * vision-capable model from the catalog (any provider), streams an image to it
 * via the standard `ProviderContract.stream` interface, and folds the textual
 * description back — so a non-vision model (e.g. glm-5.2) can still reason about
 * images, and any model can analyze image FILES referenced in code.
 *
 * Effects (filesystem, fetch) live here in the shell, injected into the service.
 * The pure decisions live in `pure.ts`. No `console.*`; logging via `host.logger`.
 */

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve as pathResolve } from "node:path";
import type { CredentialStore } from "@dispatch/credential-store";
import { credentialStoreHandle } from "@dispatch/credential-store";
import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createVisionHandoffService, visionHandoffHandle } from "./service.js";
import { createReadImageTool } from "./tool.js";

export const manifest: Manifest = {
  id: "vision-handoff",
  name: "Vision Handoff",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { services: ["vision-handoff/service"], tools: ["read_image"] },
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

/**
 * Fetch an HTTP(S) image URL and convert it to a base64 data URL (so it can be
 * sent to the vision model inline, regardless of whether the provider can fetch
 * remote URLs). The shell edge — real `globalThis.fetch`.
 */
async function fetchUrlAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image: HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const mime = res.headers.get("content-type") ?? "image/png";
  // Buffer/base64 in Bun + Node. Convert byte-by-byte without non-null asserts.
  let binary = "";
  for (const byte of buf) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  return `data:${mime};base64,${base64}`;
}

export async function activate(host: HostAPI): Promise<void> {
  const credentialStore = host.getService(credentialStoreHandle) as CredentialStore | undefined;
  if (credentialStore === undefined) {
    host.logger.warn(
      "vision-handoff: credential-store service not available. The read_image tool and image transcription are disabled.",
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
    fetchUrlAsDataUrl,
    logger: host.logger.child({ extensionId: "vision-handoff" }),
  });

  host.provideService(visionHandoffHandle, service);
  host.defineTool(createReadImageTool(service));
  host.logger.info("vision-handoff: registered (read_image tool + transcription service)");
}

export const extension: Extension = { manifest, activate };
