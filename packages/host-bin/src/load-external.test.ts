import type { Logger } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import { loadExternalExtensions } from "./load-external.js";

function makeLogger(): Logger {
  const noop = () => {};
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    span: () => {
      throw new Error("not used");
    },
  } as unknown as Logger;
  return logger;
}

describe("loadExternalExtensions", () => {
  it("returns an empty array for no specifiers", async () => {
    expect(await loadExternalExtensions([], makeLogger())).toEqual([]);
  });

  it("loads a real extension module by package name", async () => {
    // auth-apikey is a bundled extension that exports `extension`; we use it as
    // a stand-in for an external module to exercise the dynamic-import path.
    const loaded = await loadExternalExtensions(["@dispatch/auth-apikey"], makeLogger());
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.id).toBe("auth-apikey");
  });

  it("skips a specifier that cannot be imported without throwing", async () => {
    const loaded = await loadExternalExtensions(
      ["./does-not-exist-xyz.js", "@dispatch/auth-apikey"],
      makeLogger(),
    );
    // The bad one is skipped; the good one still loads.
    expect(loaded.map((e) => e.manifest.id)).toEqual(["auth-apikey"]);
  });

  it("skips a module that exports no valid extension", async () => {
    // `@dispatch/journal-sink` exports factories but no `extension`.
    const loaded = await loadExternalExtensions(["@dispatch/journal-sink"], makeLogger());
    expect(loaded).toEqual([]);
  });
});
