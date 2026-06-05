import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFixture, parseFixture, saveFixture, serializeFixture } from "./fixture.js";
import type { HttpExchangeFixture } from "./types.js";

const fixture: HttpExchangeFixture = {
	request: {
		method: "POST",
		url: "https://api.example.com/v1/chat",
		headers: { "content-type": "application/json" },
		body: '{"model":"gpt-4"}',
	},
	response: {
		status: 200,
		statusText: "OK",
		headers: { "content-type": "application/json" },
		body: '{"choices":[]}',
	},
	meta: { model: "gpt-4", capturedAt: 1700000000000, label: null },
};

const minimalFixture: HttpExchangeFixture = {
	request: { method: "GET", url: "https://x", headers: {}, body: null },
	response: { status: 204, headers: {}, body: "" },
};

describe("serializeFixture", () => {
	it("produces valid JSON", () => {
		const json = serializeFixture(fixture);
		expect(() => JSON.parse(json)).not.toThrow();
	});

	it("round-trips through parseFixture", () => {
		const json = serializeFixture(fixture);
		const parsed = parseFixture(json);
		expect(parsed).toEqual(fixture);
	});

	it("round-trips minimal fixture", () => {
		const json = serializeFixture(minimalFixture);
		const parsed = parseFixture(json);
		expect(parsed).toEqual(minimalFixture);
	});

	it("produces pretty-printed JSON with trailing newline", () => {
		const json = serializeFixture(fixture);
		expect(json).toContain("\n");
		expect(json.endsWith("\n")).toBe(true);
	});
});

describe("parseFixture", () => {
	it("throws on invalid JSON", () => {
		expect(() => parseFixture("not json")).toThrow("Invalid JSON");
	});

	it("throws on non-object", () => {
		expect(() => parseFixture('"hello"')).toThrow("Fixture must be an object");
	});

	it("throws on null", () => {
		expect(() => parseFixture("null")).toThrow("Fixture must be an object");
	});

	it("throws on missing request", () => {
		expect(() => parseFixture('{"response":{"status":200,"headers":{},"body":""}}')).toThrow(
			"request",
		);
	});

	it("throws on missing response", () => {
		expect(() =>
			parseFixture('{"request":{"method":"GET","url":"x","headers":{},"body":null}}'),
		).toThrow("response");
	});

	it("throws on non-string request.method", () => {
		const bad = {
			request: { method: 123, url: "x", headers: {}, body: null },
			response: { status: 200, headers: {}, body: "" },
		};
		expect(() => parseFixture(JSON.stringify(bad))).toThrow("request.method must be a string");
	});

	it("throws on non-number response.status", () => {
		const bad = {
			request: { method: "GET", url: "x", headers: {}, body: null },
			response: { status: "200", headers: {}, body: "" },
		};
		expect(() => parseFixture(JSON.stringify(bad))).toThrow("response.status must be a number");
	});

	it("throws on non-string response.body", () => {
		const bad = {
			request: { method: "GET", url: "x", headers: {}, body: null },
			response: { status: 200, headers: {}, body: 123 },
		};
		expect(() => parseFixture(JSON.stringify(bad))).toThrow("response.body must be a string");
	});

	it("throws on non-string header value", () => {
		const bad = {
			request: { method: "GET", url: "x", headers: { bad: 123 }, body: null },
			response: { status: 200, headers: {}, body: "" },
		};
		expect(() => parseFixture(JSON.stringify(bad))).toThrow("headers.bad must be a string");
	});

	it("throws on invalid meta value", () => {
		const bad = {
			request: { method: "GET", url: "x", headers: {}, body: null },
			response: { status: 200, headers: {}, body: "" },
			meta: { bad: {} },
		};
		expect(() => parseFixture(JSON.stringify(bad))).toThrow("meta.bad must be");
	});

	it("accepts valid meta with null/string/number/boolean", () => {
		const withMeta = {
			...minimalFixture,
			meta: { a: "s", b: 1, c: true, d: null },
		};
		const parsed = parseFixture(JSON.stringify(withMeta));
		expect(parsed.meta).toEqual({ a: "s", b: 1, c: true, d: null });
	});

	it("accepts fixture without meta", () => {
		const parsed = parseFixture(JSON.stringify(minimalFixture));
		expect(parsed.meta).toBeUndefined();
	});
});

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "trace-replay-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("saveFixture / loadFixture", () => {
	it("writes and reads back a fixture (real fs)", () => {
		const path = join(tmpDir, "test-fixture.json");
		saveFixture(path, fixture);
		const loaded = loadFixture(path);
		expect(loaded).toEqual(fixture);
	});

	it("writes and reads back a minimal fixture", () => {
		const path = join(tmpDir, "minimal.json");
		saveFixture(path, minimalFixture);
		const loaded = loadFixture(path);
		expect(loaded).toEqual(minimalFixture);
	});

	it("loadFixture throws on malformed file", () => {
		const path = join(tmpDir, "bad.json");
		const { writeFileSync } = require("node:fs") as typeof import("node:fs");
		writeFileSync(path, "not json", "utf-8");
		expect(() => loadFixture(path)).toThrow("Invalid JSON");
	});
});
