import { spawn } from "node:child_process";

/** Result of one bounded git invocation. */
export type GitRunResult =
  | { readonly exitCode: number; readonly stdout: Uint8Array; readonly stderr: string }
  | { readonly failure: "spawn" | "timeout" | "overflow" };

export interface GitRunOptions {
  readonly cwd: string;
  readonly maxStdoutBytes: number;
  readonly timeoutMs?: number;
}

/** Variables that would redirect git away from the cwd's own repository. */
const SCRUBBED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUBBED_ENV) delete env[key];
  // Never take index.lock (status refresh) — the agent may be running git concurrently.
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

/** Run `git` with bounded stdout and a timeout; never throws. */
export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", ["--no-pager", ...args], {
        cwd: options.cwd,
        env: gitEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ failure: "spawn" });
      return;
    }
    const chunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    const stderrDecoder = new TextDecoder();
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ failure: "timeout" });
    }, options.timeoutMs ?? 15000);
    child.stdout?.on("data", (chunk: Uint8Array) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxStdoutBytes) {
        child.kill("SIGKILL");
        finish({ failure: "overflow" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Uint8Array) => {
      if (stderr.length < 4096) stderr += stderrDecoder.decode(chunk, { stream: true });
    });
    child.on("error", () => finish({ failure: "spawn" }));
    child.on("close", (code) => {
      const stdout = new Uint8Array(stdoutBytes);
      let offset = 0;
      for (const chunk of chunks) {
        stdout.set(chunk, offset);
        offset += chunk.byteLength;
      }
      finish({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
