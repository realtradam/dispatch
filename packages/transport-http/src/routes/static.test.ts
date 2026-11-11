import { describe, expect, it } from "vitest";
import { staticCacheControl } from "./static.js";

describe("staticCacheControl", () => {
  it.each([
    "/assets/main-C5OpEl-J.js",
    "/assets/main-BQAnqDyy.css",
  ])("caches a content-hashed asset forever: %s", (urlPath) => {
    expect(staticCacheControl(urlPath, false)).toBe("public, max-age=31536000, immutable");
  });

  it("revalidates index.html", () => {
    expect(staticCacheControl("/index.html", false)).toBe("no-cache");
  });

  it("revalidates the SPA fallback for a root request", () => {
    expect(staticCacheControl("/", true)).toBe("no-cache");
  });

  it("revalidates the SPA fallback for a client route", () => {
    expect(staticCacheControl("/some/client/route", true)).toBe("no-cache");
  });

  it("revalidates an asset path served by the SPA fallback", () => {
    expect(staticCacheControl("/assets/anything.js", true)).toBe("no-cache");
  });

  it("revalidates a non-hashed file outside /assets/", () => {
    expect(staticCacheControl("/favicon.ico", false)).toBe("no-cache");
  });

  it("revalidates an .html file even under /assets/", () => {
    expect(staticCacheControl("/assets/page.html", false)).toBe("no-cache");
  });
});
