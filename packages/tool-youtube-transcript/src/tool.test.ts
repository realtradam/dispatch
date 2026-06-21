import { createLogger, type LogRecord, type ToolExecuteContext } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { TranscriptClient } from "./client.js";
import type { TranscriptResponse } from "./format.js";
import { createYoutubeTranscriptTool } from "./tool.js";

function stubCtx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
	return {
		toolCallId: "test-call-1",
		onOutput: () => {},
		signal: new AbortController().signal,
		log: createLogger(
			{ extensionId: "test" },
			{ emit: () => {} },
			{ now: () => 0, newId: () => "id" },
		),
		...overrides,
	};
}

function makeStubClient(
	responder: (url: string, signal: AbortSignal) => Promise<TranscriptResponse>,
): TranscriptClient {
	return { getTranscript: (url, signal) => responder(url, signal) };
}

describe("youtube_transcript", () => {
	it("returns formatted transcript on completed", async () => {
		const client = makeStubClient(async () => ({
			status: "completed",
			video_id: "vid1",
			full_text: "Hello world.",
			segments: [{ text: "Hello world.", start: 0, duration: 2 }],
		}));
		const tool = createYoutubeTranscriptTool({ client });
		const result = await tool.execute({ url: "https://youtu.be/vid1" }, stubCtx());
		expect(result.isError).toBe(undefined);
		expect(result.content).toContain("## Transcript for https://youtu.be/vid1");
		expect(result.content).toContain("**Video ID:** vid1");
		expect(result.content).toContain("Hello world.");
		expect(result.content).toContain("[0:00] Hello world.");
	});

	it("returns queued message with status and ETA", async () => {
		const client = makeStubClient(async () => ({
			status: "queued",
			video_id: "vid2",
			position: 1,
			estimated_seconds: 30,
		}));
		const tool = createYoutubeTranscriptTool({ client });
		const result = await tool.execute({ url: "https://youtu.be/vid2" }, stubCtx());
		expect(result.isError).toBe(undefined);
		expect(result.content).toContain("status: queued");
		expect(result.content).toContain("queue position: 1");
		expect(result.content).toContain("in ~30s");
		expect(result.content).toContain("https://youtu.be/vid2");
	});

	it("returns failed message", async () => {
		const client = makeStubClient(async () => ({
			status: "failed",
			video_id: "vid3",
			error: "Video unavailable",
			error_type: "NotFoundError",
		}));
		const tool = createYoutubeTranscriptTool({ client });
		const result = await tool.execute({ url: "https://youtu.be/vid3" }, stubCtx());
		expect(result.isError).toBe(undefined);
		expect(result.content).toContain("Error type: NotFoundError");
		expect(result.content).toContain("Details: Video unavailable");
	});

	it("validation error returns isError", async () => {
		const client = makeStubClient(async () => {
			throw new Error("should not be called");
		});
		const tool = createYoutubeTranscriptTool({ client });
		const result = await tool.execute({ url: "" }, stubCtx());
		expect(result.isError).toBe(true);
		expect(result.content).toContain("url");
	});

	it("uses conversationId from ctx (not required but passed through)", async () => {
		const records: LogRecord[] = [];
		const client = makeStubClient(async () => ({
			status: "completed",
			video_id: "vid4",
			full_text: "text",
			segments: [],
		}));
		const tool = createYoutubeTranscriptTool({ client });
		const ctx = stubCtx({
			conversationId: "conv-xyz",
			log: createLogger(
				{ extensionId: "test", conversationId: "conv-xyz" },
				{
					emit: (r) => {
						records.push(r);
					},
				},
				{ now: () => 0, newId: () => "id" },
			),
		});
		const result = await tool.execute({ url: "https://youtu.be/vid4" }, ctx);
		expect(result.isError).toBe(undefined);
		expect(result.content).toContain("## Transcript for");
		// The execute span flows through ctx.log, which carries conversationId.
		const spanOpen = records.find((r) => r.kind === "span-open");
		expect(spanOpen).toBeDefined();
		expect(spanOpen?.conversationId).toBe("conv-xyz");
	});

	it("writes full transcript to /tmp/dispatch/youtube-transcribe/{video_id}.txt when truncated", async () => {
		const longText = "x".repeat(60_000);
		const client = makeStubClient(async () => ({
			status: "completed",
			video_id: "vid5",
			full_text: longText,
			segments: [],
		}));
		let writtenPath = "";
		let writtenContent = "";
		const tool = createYoutubeTranscriptTool({
			client,
			outputCap: 1000,
			writeFile: (path, content) => {
				writtenPath = path;
				writtenContent = content;
			},
		});
		const result = await tool.execute({ url: "https://youtu.be/vid5" }, stubCtx());
		expect(writtenPath).toBe("/tmp/dispatch/youtube-transcribe/vid5.txt");
		expect(writtenContent).toContain("x".repeat(60_000));
		expect(result.content).toContain("/tmp/dispatch/youtube-transcribe/vid5.txt");
		expect(result.content).toContain("use read_file to access it");
		expect(result.content.length).toBeLessThan(writtenContent.length);
	});

	it("writes transcript to file even when not truncated", async () => {
		const client = makeStubClient(async () => ({
			status: "completed",
			video_id: "vid6",
			full_text: "short transcript",
			segments: [{ text: "short transcript", start: 0, duration: 2 }],
		}));
		let writtenPath = "";
		let writtenContent = "";
		const tool = createYoutubeTranscriptTool({
			client,
			writeFile: (path, content) => {
				writtenPath = path;
				writtenContent = content;
			},
		});
		const result = await tool.execute({ url: "https://youtu.be/vid6" }, stubCtx());
		expect(writtenPath).toBe("/tmp/dispatch/youtube-transcribe/vid6.txt");
		expect(writtenContent).toBe(result.content);
	});
});
