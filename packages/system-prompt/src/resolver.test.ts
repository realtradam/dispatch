import { describe, expect, it } from "vitest";
import type { GitSpawnResult, ResolverAdapters, ResolverFs } from "./resolver.js";
import { resolveVariables } from "./resolver.js";

/** A spawn that returns canned output per command (joined argv → result). */
function fakeSpawn(
  table: ReadonlyMap<string, GitSpawnResult> | GitSpawnResult,
): ResolverAdapters["spawn"] {
  return async (command) => {
    if (table instanceof Map) {
      return table.get(command.join(" ")) ?? { stdout: "", stderr: "", exitCode: 128 };
    }
    return table;
  };
}

function fakeFs(files: ReadonlyMap<string, string>): ResolverFs {
  return {
    readText: async (path: string) => files.get(path) ?? "",
    exists: async (path: string) => files.has(path),
  };
}

const failSpawn = (): ResolverAdapters["spawn"] => async () => ({
  stdout: "",
  stderr: "not a git repo",
  exitCode: 128,
});

const fixedNow = new Date("2024-06-15T12:30:00.000Z");

describe("resolver", () => {
  describe("system variables", () => {
    it("resolves system:* to non-null strings", async () => {
      // 11. system:time, system:date, system:os, system:hostname
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(new Map()),
        now: () => fixedNow,
        platform: async () => "linux",
        hostname: async () => "myhost",
      });

      expect(map.get("system:time")).toBe("2024-06-15T12:30:00.000Z");
      expect(map.get("system:date")).toBe("2024-06-15");
      expect(map.get("system:os")).toBe("linux");
      expect(map.get("system:hostname")).toBe("myhost");
    });

    it("prompt:cwd is the cwd, model/conversation_id follow context", async () => {
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(new Map()),
          now: () => fixedNow,
        },
        { context: { model: "gpt-4", conversationId: "conv-1" } },
      );

      expect(map.get("prompt:cwd")).toBe("/proj");
      expect(map.get("prompt:model")).toBe("gpt-4");
      expect(map.get("prompt:conversation_id")).toBe("conv-1");
    });

    it("prompt:model / prompt:conversation_id are null when absent", async () => {
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(new Map()),
        now: () => fixedNow,
      });

      expect(map.get("prompt:model")).toBeNull();
      expect(map.get("prompt:conversation_id")).toBeNull();
    });
  });

  describe("system:os rich resolution", () => {
    it("returns distro from /etc/os-release PRETTY_NAME on Linux", async () => {
      const files = new Map<string, string>([
        ["/etc/os-release", 'PRETTY_NAME="Ubuntu 22.04 LTS"\nNAME="Ubuntu"\n'],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(files),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("Ubuntu 22.04 LTS");
    });

    it("falls back to NAME + VERSION_ID when no PRETTY_NAME", async () => {
      const files = new Map<string, string>([
        ["/etc/os-release", 'NAME="Debian"\nVERSION_ID="12"\n'],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(files),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("Debian 12");
    });

    it("appends (WSL) when WSLInterop exists", async () => {
      const files = new Map<string, string>([
        ["/etc/os-release", 'PRETTY_NAME="Ubuntu 22.04 LTS"\n'],
        ["/proc/sys/fs/binfmt_misc/WSLInterop", "enabled\n"],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(files),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("Ubuntu 22.04 LTS (WSL)");
    });

    it("detects WSL via 'microsoft' in /proc/version", async () => {
      const files = new Map<string, string>([
        ["/etc/os-release", 'PRETTY_NAME="Ubuntu 22.04 LTS"\n'],
        ["/proc/version", "Linux version 5.15.153.1-microsoft-standard-WSL2\n"],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(files),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("Ubuntu 22.04 LTS (WSL)");
    });

    it("returns 'Linux (WSL)' when WSL detected but no distro info", async () => {
      const files = new Map<string, string>([["/proc/sys/fs/binfmt_misc/WSLInterop", "enabled\n"]]);
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(files),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("Linux (WSL)");
    });

    it("returns plain 'linux' when no os-release and no WSL", async () => {
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(new Map()),
        platform: async () => "linux",
      });
      expect(map.get("system:os")).toBe("linux");
    });

    it("returns platform as-is for non-Linux (darwin)", async () => {
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(new Map()),
        platform: async () => "darwin",
      });
      expect(map.get("system:os")).toBe("darwin");
    });
  });

  describe("file variables", () => {
    it("reads a file relative to cwd", async () => {
      // 12. file variable reads relative path; missing → null
      const files = new Map<string, string>([["/proj/AGENTS.md", "rules"]]);
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(files),
          now: () => fixedNow,
        },
        { referencedKeys: ["file:AGENTS.md"] },
      );

      expect(map.get("file:AGENTS.md")).toBe("rules");
    });

    it("missing file → null", async () => {
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(new Map()),
          now: () => fixedNow,
        },
        { referencedKeys: ["file:missing.md"] },
      );

      expect(map.get("file:missing.md")).toBeNull();
    });

    it("absolute path reads from absolute location", async () => {
      const files = new Map<string, string>([["/etc/config", "data"]]);
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(files),
          now: () => fixedNow,
        },
        { referencedKeys: ["file:/etc/config"] },
      );

      expect(map.get("file:/etc/config")).toBe("data");
    });

    it("reads nested relative path", async () => {
      const files = new Map<string, string>([["/proj/src/foo.ts", "export {}"]]);
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(files),
          now: () => fixedNow,
        },
        { referencedKeys: ["file:src/foo.ts"] },
      );

      expect(map.get("file:src/foo.ts")).toBe("export {}");
    });

    it("non-file referenced keys are not added to the map", async () => {
      const map = await resolveVariables(
        "/proj",
        {
          spawn: failSpawn(),
          fs: fakeFs(new Map()),
          now: () => fixedNow,
        },
        { referencedKeys: ["unknown:foo"] },
      );

      expect(map.has("unknown:foo")).toBe(false);
    });
  });

  describe("git variables", () => {
    it("git:branch returns the branch name", async () => {
      // 13. git:branch via injected spawn
      const table = new Map<string, GitSpawnResult>([
        ["git rev-parse --abbrev-ref HEAD", { stdout: "feature/x\n", stderr: "", exitCode: 0 }],
        ["git status --short", { stdout: " M a.ts\n", stderr: "", exitCode: 0 }],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: fakeSpawn(table),
        fs: fakeFs(new Map()),
        now: () => fixedNow,
      });

      expect(map.get("git:branch")).toBe("feature/x");
      expect(map.get("git:status")).toBe(" M a.ts");
    });

    it("non-git cwd → null", async () => {
      const map = await resolveVariables("/proj", {
        spawn: failSpawn(),
        fs: fakeFs(new Map()),
        now: () => fixedNow,
      });

      expect(map.get("git:branch")).toBeNull();
      expect(map.get("git:status")).toBeNull();
    });

    it("throwing spawn → null", async () => {
      const throwingSpawn = async (): Promise<GitSpawnResult> => {
        throw new Error("git not installed");
      };
      const map = await resolveVariables("/proj", {
        spawn: throwingSpawn,
        fs: fakeFs(new Map()),
        now: () => fixedNow,
      });

      expect(map.get("git:branch")).toBeNull();
      expect(map.get("git:status")).toBeNull();
    });

    it("clean repo → git:status is empty string (existing)", async () => {
      const table = new Map<string, GitSpawnResult>([
        ["git rev-parse --abbrev-ref HEAD", { stdout: "main\n", stderr: "", exitCode: 0 }],
        ["git status --short", { stdout: "", stderr: "", exitCode: 0 }],
      ]);
      const map = await resolveVariables("/proj", {
        spawn: fakeSpawn(table),
        fs: fakeFs(new Map()),
        now: () => fixedNow,
      });

      expect(map.get("git:status")).toBe("");
    });
  });
});
