import { describe, expect, it } from "vitest";
import {
	type CompletedResponse,
	type FailedResponse,
	formatCompleted,
	formatFailed,
	formatQueued,
	formatTimestamp,
	type QueuedResponse,
	truncateOutput,
} from "./format.js";

describe("formatTimestamp", () => {
	it("formats seconds as m:ss", () => {
		expect(formatTimestamp(65)).toBe("1:05");
		expect(formatTimestamp(723)).toBe("12:03");
	});

	it("handles zero", () => {
		expect(formatTimestamp(0)).toBe("0:00");
	});

	it("handles minutes over 60", () => {
		// 3700s = 61m40s; 4530s = 75m30s.
		expect(formatTimestamp(3700)).toBe("61:40");
		expect(formatTimestamp(4530)).toBe("75:30");
	});
});

describe("formatCompleted", () => {
	it("formats markdown with full text + segments", () => {
		const data: CompletedResponse = {
			status: "completed",
			video_id: "vid123",
			full_text: "Hello world.",
			segments: [
				{ text: "Hello world.", start: 0, duration: 2.5 },
				{ text: "Second line.", start: 65, duration: 1.0 },
			],
		};
		const out = formatCompleted("https://youtu.be/vid123", data);
		const expected = [
			"## Transcript for https://youtu.be/vid123",
			"**Video ID:** vid123",
			"",
			"### Full text",
			"",
			"Hello world.",
			"",
			"### Timestamped segments",
			"",
			"[0:00] Hello world.",
			"[1:05] Second line.",
		].join("\n");
		expect(out).toBe(expected);
	});
});

describe("formatQueued", () => {
	it("returns status + position + estimated time", () => {
		const data: QueuedResponse = {
			status: "queued",
			video_id: "vid456",
			position: 3,
			estimated_seconds: 120,
		};
		const now = () => 1_000_000_000_000;
		const out = formatQueued("https://youtu.be/vid456", data, now);
		const expectedTime = new Date(1_000_000_000_000 + 120_000).toISOString();
		const expected =
			`Transcript not yet available (status: queued, queue position: 3).\n` +
			`Estimated available at: ${expectedTime} (in ~120s).\n` +
			`URL: https://youtu.be/vid456`;
		expect(out).toBe(expected);
	});

	it("includes the processing status", () => {
		const data: QueuedResponse = {
			status: "processing",
			video_id: "vid457",
			position: 0,
			estimated_seconds: 45.5,
		};
		const out = formatQueued("https://youtu.be/vid457", data, () => 0);
		expect(out).toContain("status: processing");
		expect(out).toContain("queue position: 0");
		expect(out).toContain("(in ~46s)");
		expect(out).toContain("https://youtu.be/vid457");
	});
});

describe("formatFailed", () => {
	it("returns error type + details", () => {
		const data: FailedResponse = {
			status: "failed",
			video_id: "vid789",
			error: "Video unavailable",
			error_type: "NotFoundError",
		};
		expect(formatFailed(data)).toBe(
			"Transcript fetch failed. Error type: NotFoundError. Details: Video unavailable",
		);
	});
});

describe("truncateOutput", () => {
	it("truncates with notice when over cap", () => {
		const output = "a".repeat(100);
		const result = truncateOutput(output, 50);
		expect(result).toContain("a".repeat(50));
		expect(result).toContain("[Output truncated: exceeded 50 characters]");
		expect(result.length).toBeLessThan(output.length + 100);
	});

	it("returns as-is when under cap", () => {
		expect(truncateOutput("short", 100)).toBe("short");
		expect(truncateOutput("exact", 5)).toBe("exact");
	});
});
