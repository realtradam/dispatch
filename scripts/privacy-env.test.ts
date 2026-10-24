import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Real shell/filesystem round trips in an isolated tree. Only the outermost
// privilege/account edge is replaced: these tests NEVER invoke real sudo or
// change ownership, system configuration, services, or sibling repositories.
function fixture(initial: string) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-private-env-"));
  dirs.push(dir);
  const envFile = join(dir, "env");
  writeFileSync(envFile, initial, { mode: 0o600 });
  const executable = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o700);
    return path;
  };
  executable("id", `if [[ "\${1:-}" == -u ]]; then echo 0; else /usr/bin/id "$@"; fi`);
  executable("getent", 'printf "operator:x:1000:1000::/home/operator:/bin/bash\\n"');
  executable("chown", ": # privilege edge only; do not change ownership");
  executable(
    "privileged-edge",
    `if [[ "$1" == install ]]; then
  shift
  args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac
  done
  exec /usr/bin/install "\${args[@]}"
fi
exec "$@"`,
  );
  const run = (name: string, args: string[] = []) => {
    const source = readFileSync(resolve("bin", name), "utf8")
      .replaceAll("/etc/dispatch/env", envFile)
      .replaceAll("/etc/dispatch", join(dir, "etc"))
      .replaceAll("/var/lib/dispatch", join(dir, "data"))
      .replaceAll("/var/log/dispatch", join(dir, "logs"))
      .replaceAll("sudo ", "privileged-edge ");
    const path = executable(`run-${name}`, source);
    return spawnSync("bash", [path, ...args], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUDO_USER: "operator" },
      input: "",
      encoding: "utf8",
    });
  };
  const input = (text = endpoints) => {
    const path = join(dir, "service-endpoints.env");
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };
  return { dir, envFile, run, input, read: () => readFileSync(envFile, "utf8") };
}

const endpoints =
  "FIRECRAWL_BASE_URL=http://scraper.example:31329/v1\n" +
  "YOUTUBE_TRANSCRIBER_URL=http://[2001:db8::10]:41090\n";

describe("private service endpoint upgrade lifecycle", () => {
  it("migrates blanks/missing assignments, preserves keys/ports, and is idempotent", () => {
    const original =
      "HOME=/home/operator\nOPENCODE_API_KEY_3=fake-key\nBACKEND_PORT=4567\nFIRECRAWL_BASE_URL=";
    const f = fixture(original);
    const result = f.run("migrate-service-endpoints", [f.input()]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("scraper.example");
    expect(f.read()).toContain("OPENCODE_API_KEY_3=fake-key\nBACKEND_PORT=4567");
    expect(f.read()).toContain(endpoints.trim().split("\n")[0]);
    expect(f.read()).toContain("YOUTUBE_TRANSCRIBER_URL=http://[2001:db8::10]:41090");
    const migrated = f.read();
    expect(readFileSync(`${f.envFile}.before-service-endpoints`, "utf8")).toBe(original);
    expect(f.run("migrate-service-endpoints", [f.input()]).status).toBe(0);
    expect(f.read()).toBe(migrated);
    expect(readFileSync(`${f.envFile}.before-service-endpoints`, "utf8")).toBe(original);
    // Shared config stays shell-sourceable and exports to a child with set -a.
    expect(
      execFileSync(
        "bash",
        [
          "-c",
          'set -a; source "$1"; bash -c \'printf "%s" "$FIRECRAWL_BASE_URL"\'',
          "bash",
          f.envFile,
        ],
        { encoding: "utf8" },
      ),
    ).toBe("http://scraper.example:31329/v1");
  });

  it("never replaces an operator's nonempty override", () => {
    const f = fixture("FIRECRAWL_BASE_URL=https://custom.example/v1\n");
    expect(f.run("migrate-service-endpoints", [f.input()]).status).toBe(0);
    expect(f.read()).toContain("FIRECRAWL_BASE_URL=https://custom.example/v1");
    expect(f.read()).not.toContain("scraper.example");
  });

  it.each([
    endpoints.replace("scraper.example", "bad;touch /tmp/do-not-create"),
    endpoints.replace("scraper.example", "$(id)"),
    `${endpoints}FIRECRAWL_BASE_URL=http://duplicate.example\n`,
    "FIRECRAWL_BASE_URL=http://only-one.example\n",
    `${endpoints}UNEXPECTED=value\n`,
  ])("rejects unsafe/incomplete input before changing config", (input) => {
    const f = fixture("BACKEND_PORT=4567\n");
    expect(f.run("migrate-service-endpoints", [f.input(input)]).status).not.toBe(0);
    expect(f.read()).toBe("BACKEND_PORT=4567\n");
  });

  it("refuses a symlink env file", () => {
    const f = fixture("BACKEND_PORT=4567\n");
    const target = join(f.dir, "target");
    writeFileSync(target, f.read());
    rmSync(f.envFile);
    symlinkSync(target, f.envFile);
    expect(f.run("migrate-service-endpoints", [f.input()]).status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("BACKEND_PORT=4567\n");
  });

  it("keeps migrated endpoints/network policy through setup refresh and key sync", () => {
    const f = fixture(
      "HOME=/home/operator\nOPENCODE_API_KEY_3=fake-key\n" +
        "DISPATCH_BIND=loopback,tailscale\nDISPATCH_TAILSCALE_NAME=custom.example\n" +
        "DISPATCH_ALLOWED_HOSTS=extra.example\n",
    );
    expect(f.run("migrate-service-endpoints", [f.input()]).status).toBe(0);
    const setup = f.run("setup-env");
    expect(setup.status, setup.stderr).toBe(0);
    expect(f.read()).toContain("OPENCODE_API_KEY_3=fake-key");
    expect(f.read()).toContain(
      "PATH=/home/operator/.local/bin:/home/operator/.local/share/mise/shims:/home/operator/.bun/bin:",
    );
    for (const line of endpoints.trim().split("\n")) expect(f.read()).toContain(line);
    expect(f.read()).toContain("DISPATCH_TAILSCALE_NAME=custom.example");
    expect(f.read()).toContain("DISPATCH_BIND=loopback,tailscale");
    expect(f.read()).toContain("DISPATCH_ALLOWED_HOSTS=extra.example");
    const sync = f.run("sync-env", ["--hyper-key", "fake-hyper-key"]);
    expect(sync.status, sync.stderr).toBe(0);
    expect(f.read()).toContain("HYPER_API_KEY=fake-hyper-key");
    for (const line of endpoints.trim().split("\n")) expect(f.read()).toContain(line);
    expect(f.read()).toContain("DISPATCH_TAILSCALE_NAME=custom.example");
  });
});
