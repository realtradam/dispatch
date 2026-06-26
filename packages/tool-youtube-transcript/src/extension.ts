/**
 * tool-youtube-transcript extension — registers the `youtube_transcript` tool
 * backed by a self-hosted transcriber service on activation.
 *
 * The base URL comes from `YOUTUBE_TRANSCRIBER_URL` (env) with a Tailscale
 * default. Effects (`globalThis.fetch`) come from the ambient edge here, in
 * the shell — never in the pure core. Logging is left to the host via
 * `host.logger`/`ctx.log` (no `console.*`, no hand-rolled logger).
 */

import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { createTranscriptClient, DEFAULT_BASE_URL } from "./client.js";
import { createYoutubeTranscriptTool } from "./tool.js";

export const manifest: Manifest = {
  id: "tool-youtube-transcript",
  name: "YouTube Transcript Tool",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  activation: "eager",
  capabilities: { network: true },
  contributes: { tools: ["youtube_transcript"] },
};

export function activate(host: HostAPI): void {
  const baseUrl = process.env.YOUTUBE_TRANSCRIBER_URL ?? DEFAULT_BASE_URL;
  const client = createTranscriptClient({ baseUrl, fetchFn: globalThis.fetch });
  host.defineTool(createYoutubeTranscriptTool({ client }));
}

export const extension: Extension = { manifest, activate };
