/**
 * youtube_transcript tool factory — the imperative shell that binds the pure
 * validate/format functions to the injected TranscriptClient edge.
 *
 * Mirrors the tool-web-search pattern: factory + injected dep + pure helpers +
 * a `ToolResult` returned per call. Errors surface as `{ isError: true }`
 * rather than thrown, so the model can react to the message.
 */

import type { ToolContract, ToolExecuteContext, ToolResult } from "@dispatch/kernel";
import type { TranscriptClient } from "./client.js";
import {
	formatCompleted,
	formatFailed,
	formatQueued,
	type TranscriptResponse,
	truncateOutput,
} from "./format.js";
import { validateUrl } from "./validate.js";

const OUTPUT_CAP = 50_000;

export interface YoutubeTranscriptToolDeps {
	readonly client: TranscriptClient;
	readonly outputCap?: number;
}

const DESCRIPTION =
	"Fetch the transcript/subtitles for a YouTube video from the local transcriber " +
	"service. If the transcript has not been downloaded before, the video will be " +
	"queued for processing and the tool will return the estimated time when the " +
	"transcript will be available. When the status is 'queued' or 'processing', " +
	"you MUST append the video URL on a new line to the file .youtube_subtitles_pending " +
	"in the current working directory (create it if it does not exist). Once " +
	"available, the tool returns the full transcript text and timestamped " +
	"segments. Accepted URL formats: youtube.com/watch?v=, youtu.be/, " +
	"youtube.com/embed/, youtube.com/shorts/";

/**
 * Create the `youtube_transcript` tool. `concurrencySafe: true` — transcript
 * fetches are idempotent and safe to run alongside other tools. The `network`
 * capability is declared on the extension manifest (not the tool contract).
 */
export function createYoutubeTranscriptTool(deps: YoutubeTranscriptToolDeps): ToolContract {
	const client = deps.client;
	const cap = deps.outputCap ?? OUTPUT_CAP;

	return {
		name: "youtube_transcript",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description:
						"YouTube video URL (e.g. https://www.youtube.com/watch?v=... or https://youtu.be/...)",
				},
			},
			required: ["url"],
		},
		concurrencySafe: true,
		async execute(args: unknown, ctx: ToolExecuteContext): Promise<ToolResult> {
			const validated = validateUrl(args);
			if (typeof validated !== "string") {
				return { content: validated.error, isError: true };
			}
			const url = validated;
			const span = ctx.log.span("youtube_transcript.execute", { url });
			try {
				const data: TranscriptResponse = await client.getTranscript(url, ctx.signal);
				let output: string;
				// Check the single-literal discriminants ("completed"/"failed") first,
				// so the final else narrows to QueuedResponse — whose `status` is itself
				// a `"queued" | "processing"` union TS cannot negatively narrow.
				if (data.status === "completed") {
					output = formatCompleted(url, data);
				} else if (data.status === "failed") {
					output = formatFailed(data);
				} else {
					output = formatQueued(url, data, Date.now);
				}
				span.end();
				return { content: truncateOutput(output, cap) };
			} catch (err: unknown) {
				span.end({ err });
				return {
					content: `Error: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		},
	};
}
