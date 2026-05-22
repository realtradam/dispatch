import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolDefinition, ToolExecuteContext } from "../types/index.js";

const TRANSCRIBER_BASE = "http://100.102.55.49:41090";
const MAX_OUTPUT_CHARS = 60000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_WAIT_MS = 10 * 60 * 1000; // give up after 10 minutes of polling

interface TranscriptResponse {
	status: string;
	video_id?: string;
	full_text?: string;
	segments?: Array<{ text: string; start: number; duration: number }>;
	position?: number;
	estimated_seconds?: number;
	error?: string;
	error_type?: string;
}

async function fetchTranscript(url: string): Promise<TranscriptResponse> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const apiUrl = `${TRANSCRIBER_BASE}/api/transcript?url=${encodeURIComponent(url)}`;
		const response = await fetch(apiUrl, { signal: controller.signal });
		if (!response.ok) {
			throw new Error(`Transcriber returned HTTP ${response.status} ${response.statusText}`);
		}
		return (await response.json()) as TranscriptResponse;
	} finally {
		clearTimeout(timeout);
	}
}

function formatTime(seconds: number): string {
	const mins = Math.floor(seconds / 60);
	const secs = Math.floor(seconds % 60);
	return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatTranscript(data: TranscriptResponse): string {
	const segments = data.segments ?? [];
	const segmentsText = segments
		.map((seg) => `[${formatTime(seg.start)}] ${seg.text}`)
		.join("\n");

	const output = [
		`Video ID: ${data.video_id}`,
		"",
		"## Transcript",
		"",
		data.full_text ?? "",
		"",
		"## Timestamped Segments",
		"",
		segmentsText,
	].join("\n");

	return output.length > MAX_OUTPUT_CHARS
		? output.slice(0, MAX_OUTPUT_CHARS) + "\n\n[Transcript truncated]"
		: output;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the transcript is ready, fails, or times out. */
async function pollUntilReady(url: string): Promise<string> {
	const startTime = Date.now();

	while (Date.now() - startTime < MAX_WAIT_MS) {
		const data = await fetchTranscript(url);

		if (data.status === "completed") {
			return formatTranscript(data);
		}

		if (data.status === "failed") {
			return `Error: Transcription failed for video ${data.video_id ?? "unknown"}: [${data.error_type ?? "unknown"}] ${data.error ?? "no details"}`;
		}

		if (data.status === "queued" || data.status === "processing") {
			const estimate = data.estimated_seconds ?? 30;
			const waitMs = Math.max((estimate - 2) * 1000, 2000);
			await sleep(waitMs);
			continue;
		}

		return `Error: Unexpected transcriber response status: ${data.status}`;
	}

	return "Error: Timed out waiting for transcript after 10 minutes.";
}

/** Store for transcript polls backgrounded due to user interrupt. */
export class BackgroundTranscriptStore {
	private jobs = new Map<string, { url: string; completion: Promise<string> }>();

	register(url: string, completion: Promise<string>): string {
		const id = `youtube_transcribe_${randomUUID()}`;
		this.jobs.set(id, { url, completion });
		// Auto-cleanup 10 minutes after completion
		completion.finally(() => {
			setTimeout(() => this.jobs.delete(id), 10 * 60 * 1000);
		});
		return id;
	}

	async getResult(
		id: string,
	): Promise<{ status: "done"; result: string } | { status: "error"; error: string }> {
		const job = this.jobs.get(id);
		if (!job) {
			return { status: "error", error: `No background transcript job found with id '${id}'` };
		}
		const result = await job.completion;
		return { status: "done", result };
	}

	has(id: string): boolean {
		return this.jobs.has(id);
	}
}

export function createYoutubeTranscribeTool(
	transcriptStore?: BackgroundTranscriptStore,
): ToolDefinition {
	return {
		name: "youtube_transcribe",
		description: [
			"Fetch the transcript/subtitles for a YouTube video. This tool blocks until the transcript is ready.",
			"If the video hasn't been transcribed yet, it will be queued and this tool waits for it automatically.",
			"If the user interrupts while waiting, the request continues in the background and you receive a job ID.",
			"Use the retrieve tool with that ID to get the transcript later.",
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
		execute: async (
			args: Record<string, unknown>,
			context?: ToolExecuteContext,
		): Promise<string> => {
			const url = args.url as string;
			const queueCallbacks = context?.queueCallbacks;

			try {
				const pollPromise = pollUntilReady(url);

				if (queueCallbacks && transcriptStore) {
					const { promise: queuePromise, cancel: cancelQueueWait } =
						queueCallbacks.waitForQueuedMessage();
					const queueSignal = queuePromise.then(() => "QUEUE_INTERRUPT" as const);

					const raceResult = await Promise.race([pollPromise, queueSignal]);

					if (raceResult === "QUEUE_INTERRUPT") {
						// Background the still-polling request
						const jobId = transcriptStore.register(url, pollPromise);

						const queuedMsgs = queueCallbacks.dequeueMessages();
						const userMessages = queuedMsgs.map((m) => m.message).join("\n---\n");

						return [
							`Transcript request backgrounded — still waiting for transcription.`,
							`job_id: ${jobId}`,
							`url: ${url}`,
							``,
							`Use the retrieve tool with this job_id to get the transcript when ready.`,
							``,
							`[USER INTERRUPT]`,
							`The user has sent you message(s) while you were working. You MUST address these before continuing with your current task:`,
							``,
							userMessages,
						].join("\n");
					}

					// Poll finished before interrupt
					cancelQueueWait();
					return raceResult;
				}

				return await pollPromise;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					return "Error: Request to YouTube transcriber timed out.";
				}
				if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
					return `Error: Could not connect to YouTube transcriber at ${TRANSCRIBER_BASE}. Is it running?`;
				}
				return `Error: ${err instanceof Error ? err.message : String(err)}`;
			}
		},
	};
}
