import { z } from "zod";
import type { ToolDefinition } from "../types/index.js";

export function createYoutubeTranscribeTool(): ToolDefinition {
	return {
		name: "youtube_transcribe",
		description: [
			"Fetch the transcript/subtitles for a YouTube video from a local transcriber service.",
			"",
			"If the transcript has not been downloaded before, the video will be queued for processing.",
			"When status is 'queued' or 'processing', call this tool again later to check if the transcript is ready.",
			"",
			"Accepted URL formats:",
			"  - youtube.com/watch?v=",
			"  - youtu.be/",
			"  - youtube.com/embed/",
			"  - youtube.com/shorts/",
		].join("\n"),
		parameters: z.object({
			url: z.string().describe("The YouTube video URL to fetch the transcript for."),
		}),
		execute: async (args: Record<string, unknown>): Promise<string> => {
			const url = args.url as string;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30000);

			try {
				const apiUrl = `http://100.102.55.49:41090/api/transcript?url=${encodeURIComponent(url)}`;
				const response = await fetch(apiUrl, { signal: controller.signal });

				if (!response.ok) {
					return `Error: Transcriber service returned HTTP ${response.status} ${response.statusText}`;
				}

				const data = (await response.json()) as Record<string, unknown>;
				const status = data.status as string;

				if (status === "completed") {
					const videoId = data.video_id as string;
					const fullText = data.full_text as string;
					const segments = data.segments as Array<{ text: string; start: number; duration: number }>;

					const formatTime = (seconds: number): string => {
						const mins = Math.floor(seconds / 60);
						const secs = Math.floor(seconds % 60);
						return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
					};

					const segmentsText = segments
						.map((seg) => `[${formatTime(seg.start)}] ${seg.text}`)
						.join("\n");

					const output = [
						`Video ID: ${videoId}`,
						"",
						"## Transcript",
						"",
						fullText,
						"",
						"## Timestamped Segments",
						"",
						segmentsText,
					].join("\n");

					return output.length > 60000 ? output.slice(0, 60000) + "\n\n[Transcript truncated]" : output;
				}

				if (status === "queued" || status === "processing") {
					const videoId = data.video_id as string;
					const position = data.position as number;
					const estimatedSeconds = data.estimated_seconds as number;

					return [
						`Transcript for video ${videoId} is being processed.`,
						`Status: ${status}`,
						`Queue position: ${position}`,
						`Estimated wait time: ${estimatedSeconds} seconds`,
						"",
						"You can try calling this tool again later to check if the transcript is ready.",
					].join("\n");
				}

				if (status === "failed") {
					const videoId = data.video_id as string;
					const error = data.error as string;
					const errorType = data.error_type as string;

					return `Error transcribing video ${videoId}: [${errorType}] ${error}`;
				}

				return `Unexpected response status: ${status}`;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					return "Error: Request to YouTube transcriber timed out after 30 seconds.";
				}
				if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					return "Error: Could not connect to YouTube transcriber at http://100.102.55.49:41090. Is it running?";
				}
				return `Error: ${err instanceof Error ? err.message : String(err)}`;
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}
