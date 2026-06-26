import { readFileSync, writeFileSync } from "node:fs";
import type { HttpExchangeFixture } from "./types.js";

export function serializeFixture(fx: HttpExchangeFixture): string {
  return `${JSON.stringify(fx, null, 2)}\n`;
}

export function parseFixture(text: string): HttpExchangeFixture {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON");
  }
  assertFixture(raw);
  return raw;
}

function assertFixture(raw: unknown): asserts raw is HttpExchangeFixture {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Fixture must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.request === null || typeof obj.request !== "object" || Array.isArray(obj.request)) {
    throw new Error("Fixture.request must be an object");
  }
  const req = obj.request as Record<string, unknown>;
  if (typeof req.method !== "string") throw new Error("Fixture.request.method must be a string");
  if (typeof req.url !== "string") throw new Error("Fixture.request.url must be a string");
  assertStringRecord(req.headers, "Fixture.request.headers");
  if (req.body !== null && typeof req.body !== "string") {
    throw new Error("Fixture.request.body must be a string or null");
  }

  if (obj.response === null || typeof obj.response !== "object" || Array.isArray(obj.response)) {
    throw new Error("Fixture.response must be an object");
  }
  const res = obj.response as Record<string, unknown>;
  if (typeof res.status !== "number") throw new Error("Fixture.response.status must be a number");
  if (res.statusText !== undefined && typeof res.statusText !== "string") {
    throw new Error("Fixture.response.statusText must be a string if present");
  }
  assertStringRecord(res.headers, "Fixture.response.headers");
  if (typeof res.body !== "string") throw new Error("Fixture.response.body must be a string");

  if (obj.meta !== undefined) {
    if (obj.meta === null || typeof obj.meta !== "object" || Array.isArray(obj.meta)) {
      throw new Error("Fixture.meta must be an object if present");
    }
    const meta = obj.meta as Record<string, unknown>;
    for (const [k, v] of Object.entries(meta)) {
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new Error(`Fixture.meta.${k} must be a string, number, boolean, or null`);
      }
    }
  }
}

function assertStringRecord(val: unknown, label: string): asserts val is Record<string, string> {
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    throw new Error(`${label} must be an object`);
  }
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new Error(`${label}.${k} must be a string`);
    }
  }
}

export function saveFixture(path: string, fx: HttpExchangeFixture): void {
  writeFileSync(path, serializeFixture(fx), "utf-8");
}

export function loadFixture(path: string): HttpExchangeFixture {
  return parseFixture(readFileSync(path, "utf-8"));
}
