import { describe, expect, it } from "vitest";
import { FileChangeType, globMatch, WatchedFilesRegistry } from "./watched-files.js";

describe("watched-files", () => {
  it("register stores workspace/didChangeWatchedFiles watchers", () => {
    const registry = new WatchedFilesRegistry();

    registry.applyRegister({
      id: "reg-1",
      method: "workspace/didChangeWatchedFiles",
      registerOptions: {
        watchers: [{ globPattern: "**/*.luau" }, { globPattern: "sourcemap.json" }],
      },
    });

    const watchers = registry.getAllWatchers();
    expect(watchers).toHaveLength(2);
    expect(watchers[0]?.globPattern).toBe("**/*.luau");
    expect(watchers[1]?.globPattern).toBe("sourcemap.json");
  });

  it("a changed path matching a registered glob is forwarded as a didChangeWatchedFiles notification with the correct FileChangeType", () => {
    const registry = new WatchedFilesRegistry();

    registry.applyRegister({
      id: "reg-1",
      method: "workspace/didChangeWatchedFiles",
      registerOptions: {
        watchers: [{ globPattern: "**/*.luau" }],
      },
    });

    expect(registry.matches("src/main.luau")).toBe(true);
    expect(registry.matches("src/nested/deep/file.luau")).toBe(true);
    expect(registry.matches("src/main.ts")).toBe(false);

    expect(FileChangeType.Created).toBe(1);
    expect(FileChangeType.Changed).toBe(2);
    expect(FileChangeType.Deleted).toBe(3);
  });

  it("unregisterCapability stops forwarding", () => {
    const registry = new WatchedFilesRegistry();

    registry.applyRegister({
      id: "reg-1",
      method: "workspace/didChangeWatchedFiles",
      registerOptions: {
        watchers: [{ globPattern: "**/*.luau" }],
      },
    });

    expect(registry.matches("src/main.luau")).toBe(true);

    registry.applyUnregister({
      id: "reg-1",
      method: "workspace/didChangeWatchedFiles",
    });

    expect(registry.matches("src/main.luau")).toBe(false);
    expect(registry.getAllWatchers()).toHaveLength(0);
  });

  it("glob matching covers double-star-star.luau, sourcemap.json, double-star/sourcemap.json", () => {
    // **/*.luau
    expect(globMatch("**/*.luau", "src/main.luau")).toBe(true);
    expect(globMatch("**/*.luau", "deep/nested/file.luau")).toBe(true);
    expect(globMatch("**/*.luau", "file.luau")).toBe(true);
    expect(globMatch("**/*.luau", "src/main.ts")).toBe(false);

    // sourcemap.json (literal)
    expect(globMatch("sourcemap.json", "sourcemap.json")).toBe(true);
    expect(globMatch("sourcemap.json", "other.json")).toBe(false);

    // **/sourcemap.json
    expect(globMatch("**/sourcemap.json", "sourcemap.json")).toBe(true);
    expect(globMatch("**/sourcemap.json", "build/sourcemap.json")).toBe(true);
    expect(globMatch("**/sourcemap.json", "deep/nested/sourcemap.json")).toBe(true);
    expect(globMatch("**/sourcemap.json", "other.json")).toBe(false);
  });
});
