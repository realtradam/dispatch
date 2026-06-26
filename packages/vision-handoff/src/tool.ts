/**
 * read_image tool — lets any model (vision-capable or not) analyze an image
 * FILE on disk by handing it off to a vision-capable model.
 *
 * The tool reads the image file into a base64 data URL, then asks the vision
 * handoff service to transcribe it (via a vision-capable model resolved from
 * the catalog) and returns the textual description as the tool result. This is
 * the universal mechanism: it works regardless of whether the active model has
 * vision, because the result is plain text the model reasons about.
 *
 * For images PASTED into the chat, the orchestrator's auto-transcription handles
 * them (no tool call needed). This tool is for images REFERENCED IN CODE by path
 * (e.g. a screenshot, diagram, or mockup the model discovered while reading files).
 */

import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import type { VisionHandoffService } from "./service.js";

export function createReadImageTool(service: VisionHandoffService): ToolContract {
  return {
    name: "read_image",
    description:
      "Read and analyze an image file on disk (PNG, JPEG, WebP, GIF). Returns a " +
      "detailed textual description of the image's contents — useful when you " +
      "encounter a screenshot, diagram, UI mockup, or chart referenced in the " +
      "codebase and need to understand what it shows. The analysis is performed " +
      "by a vision-capable model, so you can use this even if you cannot " +
      "directly view images. Pass a file path (relative to the cwd or absolute).",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path to the image file to analyze. Relative paths resolve against " +
            "the conversation's working directory; absolute paths are used as-is.",
        },
      },
      required: ["path"],
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
      const input = args as { path?: unknown } | null;
      const path = input?.path;
      if (typeof path !== "string" || path.trim().length === 0) {
        return {
          content: "Error: 'path' is required and must be a non-empty string.",
          isError: true,
        };
      }
      const span = ctx.log.span("read_image.execute", { path });
      try {
        const description = await service.readImageFile(path, ctx.cwd, {
          signal: ctx.signal,
          logger: ctx.log,
        });
        span.end({ attrs: { descriptionLength: description.length } });
        return { content: description };
      } catch (err: unknown) {
        span.end({ err });
        return {
          content: `Error reading image: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
