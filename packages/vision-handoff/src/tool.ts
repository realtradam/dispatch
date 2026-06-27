/**
 * consult_vision tool — lets any model (vision-capable or not) consult a
 * vision-capable model about an image by opening a NEW conversation tab.
 *
 * The tool attaches image(s) + the model's specific question to a vision-capable
 * model (resolved from the catalog — e.g. Kimi), waits for the response, and
 * returns the conversation ID + the vision model's answer. The MODEL directs the
 * analysis — it asks exactly what it needs to know — instead of receiving a
 * pre-emptive generic dump.
 *
 * For images PASTED into the chat, the model references them by `imageIds` (from
 * the "[Image N attached]" placeholders the orchestrator injected). For image
 * FILES on disk, the model passes a `path`.
 *
 * Follow-up questions are NOT handled by this tool — the model uses the dispatch
 * CLI to continue the vision conversation (the returned conversation ID is the
 * bridge; the model can load the `dispatch-cli` skill for the exact commands).
 */

import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import type { VisionHandoffService } from "./service.js";

export function createConsultVisionTool(service: VisionHandoffService): ToolContract {
  return {
    name: "consult_vision",
    description:
      "Consult a vision-capable model (e.g. Kimi) about an image by opening a new " +
      "conversation tab. Attaches the image(s) + your specific question, waits for " +
      "the vision model's response, and returns the conversation ID + the answer. " +
      "Use this when you cannot view an image (e.g. a pasted screenshot or diagram) " +
      "and need to know what it shows — ask a SPECIFIC question (e.g. 'What error " +
      "message is on line 12?' rather than 'describe this image'). The conversation " +
      "ID is returned so follow-up questions can be asked via the dispatch CLI.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "Your specific question about the image. Be precise — the vision model " +
            "will answer exactly this. E.g. 'What error message is displayed?' or " +
            "'Compare the layout of these two screenshots.'",
        },
        imageIds: {
          type: "array",
          items: { type: "number" },
          description:
            "The IDs of pasted images to attach (from the '[Image N attached]' " +
            "placeholders in the conversation). Pass multiple to attach several " +
            "images to one consultation (e.g. [1, 2] to compare them).",
        },
        path: {
          type: "string",
          description:
            "Path to an image FILE on disk to attach (alternative to imageIds for " +
            "code-referenced images). Relative paths resolve against the cwd.",
        },
      },
      required: ["question"],
    },
    concurrencySafe: true,
    async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
      const input = args as {
        question?: unknown;
        imageIds?: unknown;
        path?: unknown;
      } | null;

      const question = input?.question;
      if (typeof question !== "string" || question.trim().length === 0) {
        return {
          content: "Error: 'question' is required and must be a non-empty string.",
          isError: true,
        };
      }

      const imageIds = input?.imageIds;
      const path = input?.path;

      // Parse imageIds (must be an array of numbers if present).
      let parsedImageIds: number[] | undefined;
      if (imageIds !== undefined) {
        if (!Array.isArray(imageIds)) {
          return { content: "Error: 'imageIds' must be an array of numbers.", isError: true };
        }
        parsedImageIds = imageIds.filter((n): n is number => typeof n === "number");
        if (parsedImageIds.length === 0) {
          return { content: "Error: 'imageIds' must contain at least one number.", isError: true };
        }
      }

      // path must be a string if present.
      let parsedPath: string | undefined;
      if (path !== undefined) {
        if (typeof path !== "string" || path.trim().length === 0) {
          return { content: "Error: 'path' must be a non-empty string.", isError: true };
        }
        parsedPath = path;
      }

      // At least one image source is required.
      if (parsedImageIds === undefined && parsedPath === undefined) {
        return {
          content:
            "Error: provide 'imageIds' (for pasted images) or 'path' (for a file) " +
            "to attach an image to the consultation.",
          isError: true,
        };
      }

      const span = ctx.log.span("consult_vision.execute", {
        imageCount: (parsedImageIds?.length ?? 0) + (parsedPath !== undefined ? 1 : 0),
      });
      try {
        const result = await service.consultVision(question, {
          conversationId: ctx.conversationId ?? "",
          ...(parsedImageIds !== undefined ? { imageIds: parsedImageIds } : {}),
          ...(parsedPath !== undefined ? { path: parsedPath } : {}),
          ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
          signal: ctx.signal,
          logger: ctx.log,
        });
        span.end({ attrs: { ok: !("error" in result) } });
        if ("error" in result) {
          return { content: result.error, isError: true };
        }
        return { content: result.response };
      } catch (err: unknown) {
        span.end({ err });
        return {
          content: `Error during vision consultation: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}
