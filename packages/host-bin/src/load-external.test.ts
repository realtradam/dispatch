import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { loadExternalExtensions } from "./load-external.js";

interface LogCall {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
}

function makeLogger(): Logger & { readonly calls: readonly LogCall[] } {
  const calls: LogCall[] = [];
  const record = (level: LogCall["level"]) => (msg: string, _meta?: unknown) => {
    calls.push({ level, msg });
  };
  const logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    child: () => logger,
    span: () => {
      throw new Error("not used");
    },
    calls,
  } as unknown as Logger & { readonly calls: readonly LogCall[] };
  return logger;
}

describe("loadExternalExtensions", () => {
  it("returns an empty array for no specifiers", async () => {
    expect(await loadExternalExtensions([], makeLogger())).toEqual([]);
  });

  it("loads a real extension module by package name", async () => {
    // heartbeat is a bundled extension that exports `extension`; we use it as a
    // stand-in for an external module to exercise the dynamic-import path.
    const loaded = await loadExternalExtensions(["@dispatch/heartbeat"], makeLogger());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe("heartbeat");
  });

  it("skips a specifier that cannot be imported without throwing", async () => {
    const loaded = await loadExternalExtensions(
      ["./does-not-exist-xyz.js", "@dispatch/heartbeat"],
      makeLogger(),
    );
    // The bad one is skipped; the good one still loads.
    expect(loaded.map((e) => e.manifest.id)).toEqual(["heartbeat"]);
  });

  it("skips a module that exports no valid extension", async () => {
    // `@dispatch/journal-sink` exports factories but no `extension`.
    const loaded = await loadExternalExtensions(["@dispatch/journal-sink"], makeLogger());
    expect(loaded).toEqual([]);
  });

  it("rejects and skips a tierless external (tier is required since plan 02)", async () => {
    const logger = makeLogger();
    // The tierless fixture is REJECTED (not pushed onto the host); a
    // valid-tier external in the same batch still loads — fault isolation.
    const loaded = await loadExternalExtensions(
      ["./__fixtures__/tierless-extension.js", "@dispatch/heartbeat"],
      logger,
    );
    expect(loaded.map((e) => e.manifest.id)).toEqual(["heartbeat"]);
    // Rejection is loud: logged at error level, naming the extension.
    expect(
      logger.calls.some(
        (c) => c.level === "error" && c.msg.includes("tierless-external") && c.msg.includes("tier"),
      ),
    ).toBe(true);
  });

  it("rejects and skips an external whose tier is not one of the three values", async () => {
    const logger = makeLogger();
    // "kernel" is NOT a tier — the kernel hosts extensions, it is not one.
    const loaded = await loadExternalExtensions(
      ["./__fixtures__/invalid-tier-extension.js"],
      logger,
    );
    expect(loaded).toEqual([]);
    expect(
      logger.calls.some((c) => c.level === "error" && c.msg.includes("invalid-tier-external")),
    ).toBe(true);
  });

  it("loads a valid-tier external (the tier gate passes it through)", async () => {
    const loaded = await loadExternalExtensions(
      ["./__fixtures__/valid-tier-extension.js"],
      makeLogger(),
    );
    expect(loaded.map((e) => e.manifest.id)).toEqual(["tiered-external"]);
    expect(loaded[0]?.manifest.tier).toBe("standard");
  });
});
