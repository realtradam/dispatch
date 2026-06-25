# SSH Support — Design & Implementation Plan

> **Status:** Planning. No implementation has begun.
> **Branch:** `feature/ssh-support`
> **Scope:** Transparent SSH execution so an agent runs commands on a remote
> computer as if local — the agent never learns it is using SSH.
> This plan follows the architecture rules in `AGENTS.md` (kernel → core →
> standard tiers; effects at the edges; contracts are the only cross-unit
> surface; one owner per unit).

---

## 0. Goals (from the feature brief)

1. **Remote computer selection** — alongside `cwd`, a user can select another
   computer to connect to via SSH. When an agent runs commands, they execute on
   that remote computer transparently. The agent must NOT know it is using SSH;
   it just runs commands and they happen on the remote machine.
2. **Workspace-level defaults** — a user can set a computer as the default for a
   workspace. Any agent summoned in that workspace without an explicitly
   assigned computer inherits the workspace's configured computer.
3. **Per-conversation override** — a conversation can specify its own computer,
   overriding the workspace default.

The non-functional requirement that shapes everything below: **transparency.**
The model sees identical tools with identical descriptions whether execution is
local or remote. Only the tool *implementation* routes differently per call.

---

## 0.5 Resolved decisions (user-confirmed 2026-06-25)

These supersede any contrary recommendation elsewhere in this document.

1. **Library:** use the regular **`ssh2`** (mscdex/ssh2) — do **not** use the
   `bun-ssh2` fork. Caveat: `ssh2` leans on Node's `crypto`, so verifying it
   runs under **Bun** is the load-bearing first step of Phase 3. If it fails,
   there is no easy fallback (fork ruled out) — escalate to the user.
2. **Host-key trust:** **auto-trust-and-pin** on first connect (record the
   fingerprint, verify on every subsequent connect, surface a mismatch loudly
   — the `StrictHostKeyChecking=accept-new` analog). A frontend "approve host
   key" prompt is a **roadmap** item (future), not MVP.
3. **Auth:** **key-only**, using the keys already installed on the Dispatch host
   under **`~/.ssh/`**. No keys in gopass/`SecretsAccess`; no password/agent
   auth in the MVP.
4. **Computer discovery (key simplification):** the list of available computers
   is **auto-discovered from the system's `~/.ssh/config`**, not hand-entered
   into a CRUD store. `computerId` **is** an SSH config `Host` alias (e.g.
   `"myserver"`). There is therefore **no `Computer` CRUD entity and no
   `computer-store` package** — only a read-only config reader + the persisted
   *assignment* (which conversation/workspace uses which alias). `~/.ssh/known_hosts`
   is the host-key trust store. (See §3 for the revised data model.)
5. **`computerId` persistence:** persisted **per-conversation** (like `cwd`),
   not per-`chat.send`. A per-turn override on `chat.send` is supported by the
   contract but not exposed in the MVP UI.
6. **LSP/MCP on remote turns:** **silently dropped** (the tools filter removes
   them; the agent sees nothing, no system-prompt note). This avoids busting
   the prompt cache. Remote LSP/MCP spawn is a future phase.
7. **`edit_file` on remote:** keeps working (writes via SFTP) with **no
   post-edit diagnostics** (the diagnostics hook returns empty — the existing
   no-LSP degradation path).

---

## 1. How execution works today (the seam we plug into)

### 1.1 The cwd → tool pipeline

`cwd` is already threaded end-to-end through a pure, injected path. SSH support
mirrors this exact path with a `computerId`:

```
ChatRequest.cwd / ChatRequest.workspaceId        (transport-contract)
  → StartTurnInput.cwd / workspaceId             (session-orchestrator)
    → runTurnDetached: getEffectiveCwd(...)        (resolve per-turn)
      → RunTurnInput.cwd                          (kernel contract)
        → StepContext.cwd                         (run-turn.ts)
          → createStepDispatcher(..., cwd)        (dispatch.ts)
            → executeToolCall(..., cwd)
              → ToolExecuteContext.cwd            (contracts/tool.ts)
                → tool.execute(args, ctx)        uses ctx.cwd
```

Key files (the single-owner units this feature touches):

| Unit (package) | Role | Current local-only behavior |
|---|---|---|
| `kernel` (contracts) | `RunTurnInput.cwd`, `ToolExecuteContext.cwd` | Threads a string; never interprets |
| `kernel` (runtime) | `dispatch.ts` `executeToolCall` builds `ToolExecuteContext` | Forwards `cwd` verbatim |
| `session-orchestrator` | `getEffectiveCwd` resolution; builds `RunTurnInput` | Resolves cwd against workspace `defaultCwd` |
| `conversation-store` | `Workspace.defaultCwd`, per-conv cwd, `getEffectiveCwd` | Stores cwd + workspace |
| `tool-shell` | `run_shell` tool; `SpawnShell` interface | `realSpawn` = `node:child_process` |
| `tool-read-file` | `read_file` tool | `node:fs/promises` directly (readdir/readFile/stat) |
| `tool-write-file` | `write_file` tool | `node:fs/promises` directly (access/stat/writeFile) |
| `tool-edit-file` | `edit_file` tool | `node:fs` directly |
| `lsp` | spawns language servers, reads/watches files | `Bun.spawn`, `Bun.file`, `node:fs.watch` |
| `mcp` | spawns MCP servers | injectable `spawn` adapter |
| `transport-http` | `POST /chat`, cwd/workspace endpoints | — |
| `transport-ws` | `chat.send` message (cwd/workspaceId) | — |
| `host-bin` | wires extensions + `process.cwd()` into tools | — |

### 1.2 The critical finding: tools hardcode `node:fs`/`node:child_process`

The shell tool already has an injectable seam — `SpawnShell`:

```ts
// packages/tool-shell/src/shell.ts
export type SpawnShell = (params: {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;
}) => Promise<SpawnResult>;
```

But it is bound **once at activation** with a fixed local spawn:

```ts
// packages/tool-shell/src/extension.ts
host.defineTool(createRunShellTool({ workdir: process.cwd(), spawn: realSpawn }));
```

The filesystem tools (`read_file`, `write_file`, `edit_file`) are **worse**: they
call `node:fs/promises` *directly inside `execute()`*, with no injection seam at
all. The only injection is the `workdir` (bound to `process.cwd()` at boot).

**Implication:** transparency is not free. To run a tool remotely, the tool must
resolve its execution backend *per call* from `ToolExecuteContext` — not from a
binding fixed at activation. This requires:

1. A new `ExecBackend` (a.k.a. host backend) abstraction over spawn + fs.
2. Threading a `computerId` through `ToolExecuteContext` (mirroring `cwd`).
3. Refactoring the filesystem tools to use the injected backend instead of
   `node:fs` directly.

### 1.3 The workspace model we mirror

`getEffectiveCwd` (conversation-store) is the exact resolution pattern to clone
for computers:

1. **Absolute per-conversation cwd** → used outright
2. **Relative per-conversation cwd** → resolved against workspace `defaultCwd`
3. **No per-conversation cwd** → workspace `defaultCwd`
4. **Neither** → `serverDefaultCwd` (`process.cwd()`)

For computers the ladder is:

1. **Per-conversation `computerId`** → used outright
2. **No per-conversation `computerId`** → workspace `defaultComputerId`
3. **Neither** → `null` = **local** (no SSH; today's behavior)

`null` (local) is the "server default" equivalent — and it is the ONLY level
that requires no SSH, so the feature degrades cleanly to today's behavior when no
computer is configured anywhere.

---

## 2. Core design: the `ExecBackend` abstraction

### 2.1 The contract (new, lives in a new core extension `exec-backend`)

The central abstraction is an `ExecBackend`: the union of spawn + filesystem
operations a tool needs, expressed against **paths and bytes**, never against
`node:fs`/`child_process`. There are exactly two implementations:

- `LocalExecBackend` — wraps `node:fs/promises` + `node:child_process` (today's
  behavior, factored out).
- `SshExecBackend` — wraps `ssh2` `exec` + `sftp` (new, in the `ssh` extension).

```ts
// packages/exec-backend/src/backend.ts  (NEW core extension)

/** A spawned process's stdio handles + lifecycle, transport-agnostic. */
export interface ExecResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface SpawnParams {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;
}

/** Stat result — the subset read_file/write_file/edit_file need. */
export interface StatResult {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/**
 * The execution backend: spawn + a minimal filesystem surface.
 * Tools program against THIS, never against node:fs. Two implementations:
 * local (node) and ssh (ssh2). Resolved per-call from ToolExecuteContext.
 *
 * Deliberately a SMALL surface (only what the bundled tools use) so a remote
 * implementation is tractable. New operations are added here, not ad hoc.
 */
export interface ExecBackend {
  /** Run a shell command, streaming stdout/stderr. The shell-tool seam. */
  readonly spawn: (params: SpawnParams) => Promise<ExecResult>;

  // --- filesystem (the read_file / write_file / edit_file surface) ---
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly stat: (path: string) => Promise<StatResult>;
  readonly readdir: (path: string) => Promise<readonly { readonly name: string; readonly isDirectory: boolean }[]>;
  /** Check existence without throwing. */
  readonly exists: (path: string) => Promise<boolean>;
}
```

### 2.2 Resolution: `computerId` on `ToolExecuteContext` + a resolver

The tool cannot reach the Host API at `execute` time (it only gets
`ToolExecuteContext`). So resolution flows through the context, mirroring `cwd`:

**Kernel contract change** (additive, optional field — backward compatible):

```ts
// packages/kernel/src/contracts/tool.ts  (MODIFIED)
export interface ToolExecuteContext {
  readonly toolCallId: string;
  readonly onOutput: (data: string, stream: "stdout" | "stderr") => void;
  readonly signal: AbortSignal;
  readonly log: Logger;
  readonly cwd?: string;
  readonly conversationId?: string;
  /**
   * The computer this tool-call executes on (NEW). When omitted/undefined,
   * execution is LOCAL (today's behavior). When set, tools resolve a remote
   * ExecBackend via the injected resolver. The kernel never interprets it —
   * it forwards verbatim from RunTurnInput, like cwd.
   */
  readonly computerId?: string;
}
```

```ts
// packages/kernel/src/contracts/runtime.ts  (MODIFIED — RunTurnInput)
export interface RunTurnInput {
  // ...existing fields...
  readonly cwd?: string;
  /**
   * The computer to execute this turn's tools on (NEW). Omitted = local.
   * Forwarded verbatim to each ToolExecuteContext.computerId. Like cwd, it
   * never enters the model prompt (no prompt-cache impact).
   */
  readonly computerId?: string;
  // ...
}
```

The dispatch runtime (`executeToolCall`) threads `computerId` exactly as it does
`cwd` today (one extra optional arg / field).

### 2.3 How a tool resolves its backend

Each affected tool is constructed with an injected **backend resolver** — a
function `(computerId?) => ExecBackend`. At `execute` time it calls
`resolveBackend(ctx.computerId)`:

```ts
// packages/tool-shell/src/shell.ts  (MODIFIED factory signature)
export function createRunShellTool(deps: {
  readonly workdir: string;
  /** Resolve the execution backend for a call. computerId undefined = local. */
  readonly resolveBackend: (computerId?: string) => ExecBackend;
  readonly outputCap?: number;
}): ToolContract {
  // ...
  async execute(args, ctx) {
    // ...
    const backend = deps.resolveBackend(ctx.computerId);
    spawnResult = await backend.spawn({ command, cwd: effectiveCwd, signal, timeout, onOutput });
    // ...
  }
}
```

The `LocalExecBackend` ignores `computerId`; the `SshExecBackend` is built for a
specific connection (see §4). The resolver (provided by the `exec-backend`
extension via a service handle, wired in `host-bin`) returns the right one.

> **Why a resolver function and not `host.getService` inside execute?** Tools
> don't receive `host` at execute time — only `ToolExecuteContext`. Injecting the
> resolver at construction (like `spawn` today) keeps the tool pure-ish and
> testable (a test injects a fake resolver), consistent with the existing
> `SpawnShell`/`McpExtensionDeps` injection patterns. The resolver is the ONE
> piece of ambient-ish wiring; it is owned by the `exec-backend` extension and
> is reproducible from inputs (computerId → backend).

### 2.4 The filesystem tools must be refactored

`read_file`/`write_file`/`edit_file` currently call `node:fs/promises` inline.
They must be rewritten to call `backend.readFile(...)` etc. through the same
injected resolver. The pure logic (validate args, slice lines, diff, decide
overwrite) stays pure and untouched — only the I/O calls move behind the
backend. This is the bulk of the mechanical work but is low-risk: the contract is
a strict subset of `node:fs`.

---

## 3. Data model: the `Computer` is a view over `~/.ssh/config`

> **Revised per decision #4.** There is no persisted `Computer` CRUD entity. A
> "computer" is a `Host` alias in the system's `~/.ssh/config`, discovered
> read-only. Dispatch stores only the *assignment* (an alias string) per
> conversation and per workspace — exactly parallel to how `cwd` is a string
> stored alongside everything else.

### 3.1 The `Computer` view (wire — read-only)

`listComputers()` parses `~/.ssh/config` and returns one entry per named
(non-wildcard) `Host` alias, with the connection params resolved from the
config (first-match-wins for `HostName`/`User`/`Port`/`IdentityFile`):

```ts
// packages/wire/src/index.ts  (NEW — read-only view, not an editable entity)
export interface Computer {
  /** The SSH config `Host` alias — also the computerId users select. */
  readonly alias: string;
  /** Resolved HostName/IP from the config (falls back to the alias itself). */
  readonly hostName: string;
  /** Resolved port (config `Port`, default 22). */
  readonly port: number;
  /** Resolved user (config `User`, default current user). */
  readonly user: string;
  /** Resolved IdentityFile path (config, or null = default ~/.ssh/id_*). */
  readonly identityFile: string | null;
  /**
   * Whether the host's key is already in ~/.ssh/known_hosts (i.e. previously
   * connected). Drives the FE "known/new" indicator. Read-only.
   */
  readonly knownHost: boolean;
}

export interface ComputerEntry extends Computer {
  /** Number of conversations/workspaces whose computerId resolves to this alias. */
  readonly usageCount: number;
}
```

`Computer` is **not editable through the API** — to add a computer, the user
adds a `Host` block to `~/.ssh/config` (the file they already manage). This is
the deliberate simplification: the source of truth is the user's existing SSH
config, so there is nothing to keep in sync.

### 3.2 No `computer-store` package

Because there is no `Computer` entity to CRUD, the dedicated `computer-store`
package is **eliminated**. What remains:

- A **read-only config reader** (`parseSshConfig()`) — lives inside the `ssh`
  extension (it owns SSH concern end-to-end). It uses the `ssh-config` package
  (project-local dep, see §13.Q) to parse `~/.ssh/config` correctly (wildcards,
  `Include`, first-match-wins) rather than hand-rolling.
- The **persisted assignment** — `computerId` per-conversation + `defaultComputerId`
  per workspace — stored as strings alongside `cwd`/`defaultCwd`. This is owned
  by **`conversation-store`** (it already owns the workspace row + per-conv
  keys). The `getEffectiveComputer` resolution (§3.3) lives in `conversation-store`
  too, mirroring `getEffectiveCwd`.

So the only new contract surface for storage is on `conversation-store`
(§3.4) — there is no separate store unit.

### 3.3 The resolution ladder (`getEffectiveComputer`)

```
1. overrideComputerId (per-turn, from chat.send)      → return alias (or null)
2. per-conversation computerId (persisted)             → return alias (or null)
3. workspace defaultComputerId                         → return alias (or null)
4. none of the above                                   → null  (LOCAL)
```

`null` is the deliberate "local" sentinel — no SSH connection, today's behavior.
A new conversation in a workspace with a `defaultComputerId` inherits it without
persisting anything itself. **Note:** `getEffectiveComputer` returns the alias
*string* (or null); it does NOT validate the alias exists in `~/.ssh/config`
(validation happens at connect time — a stale alias yields a clear connect error
rather than silently falling back to local).

### 3.4 `Workspace` gains `defaultComputerId` (conversation-store)

```ts
// packages/wire/src/index.ts  (MODIFIED)
export interface Workspace {
  readonly id: string;
  readonly title: string;
  readonly defaultCwd: string | null;
  /** NEW: default computer (SSH config alias) for conversations in this workspace. null = local. */
  readonly defaultComputerId: string | null;
  readonly createdAt: number;
  readonly lastActivityAt: number;
}
```

`conversation-store` gains, parallel to `cwd`/`defaultCwd`:
- `getComputerId(convId) / setComputerId(convId, alias | null) / clearComputerId`
  (per-conversation, mirror `getCwd`/`setCwd`/`clearCwd`)
- `setWorkspaceDefaultComputerId(wsId, alias | null)` (mirror
  `setWorkspaceDefaultCwd`)
- `getEffectiveComputer(convId, overrideAlias?)` (mirror `getEffectiveCwd`)

This is the **one contract gap** this plan reports to the `conversation-store`
owner: new per-conversation keys + a `WorkspaceRow.defaultComputerId` field + a
setter + `getEffectiveComputer`. (Per the constitution, the planner does not
edit conversation-store; it reports the needed change.)

---

## 4. SSH connection management (the `ssh` extension)

### 4.1 Library

**`ssh2`** (mscdex/ssh2, v1.17.0) — the standard pure-JS SSH2 client, MIT, 5.8k
stars, 2k+ dependents. It provides:

- `client.exec(command, opts)` → a stream with `stdout`/`stderr` `'data'` events
  and an `'exit'` event (exit code). This maps directly onto `SpawnShell`.
- `client.sftp()` → an SFTP session with `readFile`, `writeFile`, `stat`,
  `readdir`, `createReadStream`/`createWriteStream`. This implements the fs half
  of `ExecBackend`.
- Auth: `privateKey`, `password`, `agent` (`ssh-agent`), `keyboard-interactive`.

**Bun compatibility:** `ssh2` relies on Node's `crypto`/`Stream` APIs. The
project runs on **Bun**. Per decision #1, we use `ssh2` directly (the fork is
ruled out). This makes verifying it under Bun the **load-bearing first step of
Phase 3**: a smoke test that connects + `exec`s a command under Bun. If it
fails, there is no easy fallback — escalate to the user (the fork was rejected,
so the only options would be a different SSH approach or a Bun-native client).

> **Action for the user (package install):** SSH support needs the `ssh2`
> dependency added to `packages/ssh/package.json`, plus `ssh-config` for parsing
> `~/.ssh/config` (see §3.2). Per the package install policy, I will not install
> system-wide; the implementation agent adds them as project-local dependencies
> (`bun add ssh2 ssh-config` in the package). No system package is required
> (ssh2 ships its own crypto; OpenSSH is not needed on the Dispatch host — the
> library IS the SSH client).

### 4.2 Connection pooling

A single `ssh2` `Client` connection can run **many** `exec` calls and **one**
SFTP session concurrently, so we pool **one connection per computer alias** (the
alias's connection params are resolved once from `~/.ssh/config` and are stable
for the connection's life). This is the `SshConnectionPool`, owned by the `ssh`
extension:

```ts
// packages/ssh/src/pool.ts  (NEW)
export interface SshConnection {
  /** Acquire the live ssh2 Client (connects lazily on first acquire). */
  readonly getClient: () => Promise<ssh2.Client>;
  /** Acquire a shared SFTP session (lazily created, reused). */
  readonly getSftp: () => Promise<ssh2.SFTPWrapper>;
  readonly close: () => Promise<void>;
  /** Live status for the frontend status endpoint. */
  readonly state: "disconnected" | "connecting" | "connected" | "error";
}

export interface SshConnectionPool {
  /** Get-or-connect the pooled connection for a computer. */
  readonly acquire: (computerId: string) => Promise<SshConnection>;
  /** Close + drop a single computer's connection (on error / manual disconnect). */
  readonly drop: (computerId: string) => Promise<void>;
  /** Close all (shutdown). */
  readonly closeAll: () => Promise<void>;
  /** Status snapshot for all known computers. */
  readonly status: () => readonly { readonly computerId: string; readonly state: SshConnection["state"]; readonly error?: string }[];
}
```

**Lifecycle / pooling rules:**

- **Lazy connect:** the first `acquire(computerId)` for a computer opens the
  connection. Subsequent acquires reuse it (no reconnect per command — this is
  the transparency + performance win over spawning `ssh` per call).
- **Keep-alive:** ssh2 supports `keepaliveInterval` / `keepaliveCountMax`.
  Configure (e.g. 30s interval, 3 misses) so idle pooled connections detect
  dead peers without a user-visible hang.
- **Idle reaping:** a periodic sweep closes connections unused for N minutes
  (configurable; default ~15m) to avoid holding sockets on remote hosts. The
  next `acquire` reconnects transparently.
- **Per-computer single connection** is the MVP. If a remote host becomes a
  bottleneck (many concurrent tool calls — note the default dispatch is
  `maxConcurrent: 1`, so this is unlikely), the pool can grow to a small cap
  (e.g. 3) per computer later. SFTP is a single session per connection; if fs
  contention appears, open additional SFTP sessions on the same connection.

### 4.3 The `SshExecBackend`

Built per `acquire`, wrapping the pooled connection's `exec` + `sftp`:

```ts
// packages/ssh/src/backend.ts  (NEW)
export function createSshExecBackend(conn: SshConnection, computer: Computer): ExecBackend {
  return {
    async spawn(params) {
      const client = await conn.getClient();
      // sh -c on the remote, cwd via `cd <cwd> && ...` or exec opts.
      // ssh2 exec has no cwd option → prefix `cd "$cwd" && ` (shell-quoted).
      const wrapped = `cd ${shellQuote(params.cwd)} && ${params.command}`;
      return new Promise((resolve) => {
        client.exec(wrapped, { pty: false }, (err, stream) => {
          if (err) return resolve({ exitCode: 1, timedOut: false, aborted: false });
          // wire stream.stdout/stderr 'data' → params.onOutput
          // wire stream 'exit'/'close' → resolve({exitCode, ...})
          // wire params.signal abort → stream.end(); resolve aborted
          // wire params.timeout → stream.end(); resolve timedOut
        });
      });
    },
    async readFile(path) { const sftp = await conn.getSftp(); return sftp.readFile(path, "utf8"); /* throws ENOENT → map */ },
    async writeFile(path, content) { const sftp = await conn.getSftp(); return sftp.writeFile(path, content, "utf8"); },
    async stat(path) { const sftp = await conn.getSftp(); const s = await sftp.stat(path); return { isFile: s.isFile(), isDirectory: s.isDirectory() }; },
    async readdir(path) { const sftp = await conn.getSftp(); const list = await sftp.readdir(path); /* map → {name, isDirectory} */ },
    async exists(path) { try { await sftp.stat(path); return true; } catch { return false; } },
  };
}
```

**Error mapping:** `node:fs` throws `ENOENT` etc. with `.code`. ssh2/SFTP errors
have different shapes. The `SshExecBackend` maps them to the `node:fs`-style
errors the existing tool pure-logic expects (e.g. `(err as NodeJS.ErrnoException).code
=== "ENOENT"`), so the tools' existing error branches (`read_file`'s "File not
found") work unchanged. This mapping lives in the backend, not the tools.

### 4.4 Auth & host-key verification

Per decisions #2 and #3, auth is **key-only, from `~/.ssh/`** — no
`SecretsAccess`/gopass, no passwords, no agent in the MVP.

- **Key resolution at connect time:** the `ssh` extension resolves the alias →
  `IdentityFile` from `~/.ssh/config` (§3.1). If the config specifies one, read
  that file; otherwise fall back to the default identity files (`~/.ssh/id_rsa`,
  `~/.ssh/id_ed25519`, etc., first that exists). The key material is read from
  disk and passed to `ssh2` as `privateKey` (with passphrase support — prompted
  via the FE roadmap item, or empty for unencrypted keys in the MVP). The key
  never leaves the `ssh` extension and is never persisted.
- **No secrets in the API or store.** Because the key lives on disk in
  `~/.ssh/`, there is no `secretRef` field, no secret store wiring, and no
  secret transit through env/containers. This is the simplification from
  decision #3.
- **Host-key verification (auto-trust-and-pin):** uses `~/.ssh/known_hosts`
  directly. On connect, the `ssh2` `hostVerifier` callback checks whether the
  host key is in `known_hosts`: if present, verify it matches (reject on
  mismatch — surface "HOST KEY CHANGED" loudly, never silently connect); if
  **absent** (first connect), accept and append the fingerprint to
  `known_hosts` (the `StrictHostKeyChecking=accept-new` analog). A future FE
  "approve host key" prompt (roadmap, decision #2) would gate that first
  accept.
- **No agent-forwarding** (avoids credential leakage to the remote).
- Future: `agent`/`password` auth can be added later behind the same connect
  path if needed; not in scope for the MVP.

---

## 5. Integration with the turn loop & tool dispatch

### 5.1 Threading `computerId` end-to-end

The change is a strict superset of the cwd threading — one more optional field
at each hop:

```
ChatRequest.computerId (NEW) / Workspace.defaultComputerId (NEW)
  → StartTurnInput.computerId (NEW)
    → runTurnDetached: getEffectiveComputer(...) (NEW resolution)
      → RunTurnInput.computerId (NEW)
        → StepContext.computerId (NEW)
          → createStepDispatcher(..., computerId) (NEW arg)
            → executeToolCall(..., computerId) (NEW arg)
              → ToolExecuteContext.computerId (NEW)
                → tool.execute resolves backend from ctx.computerId
```

Every one of these is **additive and optional** — when `computerId` is absent
everywhere, behavior is byte-identical to today (local). This is the
backward-compatibility invariant.

### 5.2 session-orchestrator changes

`runTurnDetached` already resolves `effectiveCwd` via a chained promise. It
gains a parallel `effectiveComputer` resolution (mirroring the cwd promise),
then a `resolveBackend` is wired so tools get the right backend. Concretely:

- Add `computerId?: string` to `StartTurnInput`.
- Resolve `effectiveComputerId` = `computerStore.getEffectiveComputer(convId, override)`.
- Persist per-conversation `computerId` on first turn (like cwd).
- Thread `computerId` into `RunTurnInput` (line ~589 where `opts` is built).
- The `TurnLifecyclePayload` gains `computerId` (for cache-warming symmetry —
  a warm probe must assemble tools under the same computer so the *tool
  descriptions* match; see §5.4).

### 5.3 The `exec-backend` extension wires the resolver

A new core extension `exec-backend` provides a service handle
`execBackendHandle: ServiceHandle<ExecBackendResolver>` where
`ExecBackendResolver = (computerId?: string) => ExecBackend`. Its implementation:

```ts
function resolveBackend(computerId?: string): ExecBackend {
  if (computerId === undefined) return localBackend;          // local
  const ssh = sshPool.acquire(computerId);                     // remote (async!)
  return sshBackendFor(computerId);
}
```

**Subtlety: `acquire` is async.** The resolver must return a backend whose
methods are async (they already are — `spawn`/`readFile` return Promises), so
the connection is acquired lazily *inside* the first backend method call, not
at resolver-call time. The resolver stays synchronous; the `SshExecBackend`
captures the `computerId` + a lazy `acquire` thunk. This keeps the resolver
side-effect-free (no connection opened merely by resolving a backend — only
when a tool actually executes).

The tool extensions (`tool-shell`, `tool-read-file`, `tool-write-file`,
`tool-edit-file`) gain a `resolveBackend` dep injected at activation
(`host-bin` wires `host.getService(execBackendHandle)`).

### 5.4 Cache-warming & prompt-cache safety

`cache-warming` replays the conversation's prefix to warm the provider cache. It
assembles tools via `applyToolsFilter` under the *same cwd* today. With SSH, the
**tool descriptions are unchanged** (transparency!), so the prompt-cache prefix
is unaffected by the computer — UNLESS a tools-filter changes the tool *set*
based on computer (e.g. dropping LSP tools when remote; see §6). The plan:
`WarmService.warm` and the tools-filter must thread `computerId` so any
computer-sensitive filtering is byte-stable between warm and real turns. This
is the same invariant the codebase already enforces for cwd.

### 5.5 System prompt

The system prompt is cwd-aware today (it may include the cwd). For transparency,
the prompt should NOT reveal "you are on a remote machine" — the agent must not
know. The cwd shown to the model is the *remote* cwd (a path on the remote
machine), which is already what `ctx.cwd` would be. No system-prompt change is
required for transparency. (Optionally, a future `{{computer}}` template variable
could be added, but that would *break* transparency — out of scope / discouraged.)

---

## 6. LSP, MCP, and other spawned-process extensions

### 6.1 LSP — the hard case

The LSP extension spawns a **language server process** (e.g. `typescript-language-server`)
rooted at the workspace, communicating over stdio. For full transparency, this
process would need to run on the remote machine and Dispatch would bridge its
stdio over SSH. ssh2 supports this (`client.exec` with a shell that runs the
server, forwarding its stdio) — but it is significantly more complex than file
ops (long-lived process, framing, file-watching over SFTP).

**MVP decision: degrade gracefully.** When `effectiveComputer !== null` (remote):

- The `lsp` tool's per-edit diagnostics are **skipped** (the `edit_file` tool
  already degrades to no-diagnostics when LSP is unavailable — the existing
  try/catch path).
- The LSP status endpoint reports "disabled on remote computers" for that
  conversation.

**Future phase:** a `RemoteLspManager` that spawns the language server over SSH
and bridges stdio + uses SFTP for `didOpen`/file-watching. This is a large,
separate unit of work and is **out of scope** for the initial SSH feature. The
plan records it as a known limitation; the `lsp` extension owner gets a
change-request when remote LSP is prioritized.

This is enforced cleanly via the **tools filter**: the session-orchestrator's
`toolsFilter` (owned by session-orchestrator) drops the `lsp` tool from the
turn's tool set when `effectiveComputer !== null`. The model simply doesn't see
the `lsp` tool on remote turns — consistent with how MCP drops disconnected
servers' tools today.

### 6.2 MCP

MCP servers are configured per-cwd (`.dispatch/mcp.json`). They spawn local
processes. For a remote conversation, the MCP servers should be **discovered on
the remote machine** (read the remote `.dispatch/mcp.json` via SFTP) and spawned
remotely. This is also complex (long-lived remote processes).

**MVP decision:** MCP tools are **also dropped** via the tools filter when
remote (same mechanism as LSP). A future phase adds remote MCP server spawn
over SSH. Recorded as a known limitation.

### 6.3 Tools unaffected by SSH

`web_search`, `youtube_transcript` — these hit the network from the Dispatch host
(not the remote machine), so they are **unaffected** and remain available on
remote turns. `todo` is in-memory. These need no changes.

---

## 7. Security considerations

1. **No secrets managed by Dispatch (decision #3).** SSH private keys live on
   disk in `~/.ssh/` (the user's existing, file-permission-protected keys).
   Dispatch reads the key file at connect time and holds it only in the `ssh`
   extension's process memory (on the pooled connection). It is never
   persisted, never logged, never returned by any API. File permissions on
   `~/.ssh/` (typically `0600`) are the protection — Dispatch relies on them.
2. **No `secretRef`/gopass wiring (removed).** The secrets-management skill is
   not involved for SSH; keys are filesystem, not gopass.
3. **Host-key verification (auto-trust-and-pin, decision #2).** ssh2's
   `hostVerifier` callback checks `~/.ssh/known_hosts`: present → verify match
   (reject on mismatch, surface "HOST KEY CHANGED" loudly, never silently
   connect — prevents MITM); absent (first connect) → accept and append the
   fingerprint to `known_hosts` (the `StrictHostKeyChecking=accept-new` analog).
   A future FE "approve host key" prompt (roadmap) would gate that first accept.
4. **No agent-forwarding** by default (avoids credential leakage to the remote).
5. **No PTY by default** for `exec` (`pty: false`) — commands run non-interactively,
   output captured as today. PTY would risk leaking control chars / interactive
   prompts hanging.
6. **Command injection** — the shell tool already passes the model's `command`
  to `sh -c` locally; SSH does not change this threat model (the agent is already
  trusted to run arbitrary commands). The `cd "$cwd" && ` prefix must
  **shell-quote** the cwd to avoid a cwd containing shell metachars breaking
  out — use a proper quoting helper, not string concat.
7. **Port exposure** — SSH is outbound from the Dispatch host; no inbound ports
   opened. No change to the existing TLS/cert posture.
8. **Auth method policy (MVP)** — key-only (decision #3). Password/agent are
   out of scope; if added later, passwords must never be stored in plaintext
   (would require reintroducing a secret store).
9. **Auditability** — every remote `exec`/fs op should be logged via the
   injected `Logger` (the `ssh` extension spans each operation with the alias),
   so remote activity is traceable. Existing observability (trace-store) covers
   this if spans are opened.

---

## 8. Edge cases

| Case | Handling |
|---|---|
| **Connection drop mid-turn** | The pooled connection errors. The in-flight `spawn`/fs call rejects; the tool returns an error result (`isError: true`) with a clear message ("remote computer connection lost: …"). The model sees a normal tool error and can retry. The pool drops the dead connection; next `acquire` reconnects. The turn is NOT aborted (unlike a signal abort) — the model continues. |
| **Remote machine offline (connect fails)** | First `acquire` rejects with a connect error → tool error result. A `GET /computers/:alias/status` lets the FE show "offline" before the user sends. |
| **Timeout** | Each `spawn` carries its own `timeout` (existing tool param, default 120s). The backend enforces it over SSH (close the stream on timeout) — same `timedOut` result as local. Connect itself has a separate (shorter, e.g. 10s) connect timeout so an unreachable host fails fast. |
| **Auth failure** | Connect rejects with auth error. Surface a specific error ("SSH authentication failed for computer X") via the tool result + the status endpoint. Never retry in a tight loop (avoid account lockout) — fail and let the user fix the secret. |
| **cwd doesn't exist on remote** | `cd <cwd>` fails on the remote shell → the command exits non-zero with stderr "no such directory". The tool returns an error result; the model can `cd`/`ls` to recover. Same UX as a bad local cwd. |
| **Path semantics differ (Windows remote)** | MVP assumes POSIX remotes (ssh2 + sh -c). A Windows remote would need `cmd.exe` + path translation — **out of scope**; documented as POSIX-only. |
| **Long output** | The existing `OUTPUT_CAP` (50k chars) truncation in the shell tool applies identically — the backend streams stdout; the tool caps. No change. |
| **Concurrent tool calls to same remote** | Default dispatch `maxConcurrent: 1` serializes, so one command at a time. With parallelism enabled, the pooled connection handles concurrent `exec` (ssh2 supports it); SFTP ops are serialized within the single SFTP session or open additional sessions. |
| **Computer removed from `~/.ssh/config` while in use** | There's no delete API (config is the source of truth). If a user removes the `Host` block, in-flight calls keep running (the pooled connection is already open); the next `acquire` after the pool reaps it fails to resolve the alias → clear "unknown computer alias" error. The persisted `computerId`/`defaultComputerId` assignment still points at the stale alias; the FE should flag it as unresolved. |
| **Aborted turn** | `ctx.signal` is threaded into the backend (`spawn` params already take `signal`). On abort, the backend closes the remote stream (best-effort `stream.end()`); the promise resolves `aborted`. The pooled connection stays alive for reuse. |
| **Key rotated/removed on disk** | Next `acquire` after a drop re-reads the key from `~/.ssh/`. If removed or unreadable, connect fails with an auth/read error. |

---

## 9. API surface (transport-contract + transport-http + transport-ws)

All **additive**. Existing endpoints/messages unchanged.

### 9.1 Computer endpoints (read-only discovery + status)

Per decision #4, computers are **discovered from `~/.ssh/config`**, so there is
**no create/update/delete** — only read + status + test:

```
GET    /computers                          → { computers: ComputerEntry[] }   (parses ~/.ssh/config)
GET    /computers/:alias                   → Computer                          (resolved config entry)
GET    /computers/:alias/status            → { alias, state: "disconnected"|"connecting"|"connected"|"error", error?, knownHost: bool }
POST   /computers/:alias/test              → probe-connect (opens a test connection, reports ok/error + pins host key)
```

`:alias` is the SSH config `Host` alias. To "add" a computer, the user edits
`~/.ssh/config` (their own file) — there is no `PUT /computers`. `knownHost`
reflects whether the alias's host is already in `~/.ssh/known_hosts`.

### 9.2 Per-conversation + workspace-default endpoints (mirror cwd)

```
GET    /conversations/:id/computer         → { conversationId, computerId: string | null }
PUT    /conversations/:id/computer         → { computerId: string | null }   (null = clear → inherit/local)
DELETE /conversations/:id/computer         → clear (same as PUT null)

PUT    /workspaces/:id/default-computer    → { computerId: string | null }  (mirror /workspaces/:id/default-cwd)
```

`GET /workspaces/:id` and `GET /workspaces` return the new `defaultComputerId`
field (additive).

### 9.3 Chat request gains `computerId`

```ts
// transport-contract ChatRequest  (MODIFIED — additive optional field)
export interface ChatRequest {
  readonly conversationId?: string;
  readonly message: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly workspaceId?: string;
  /** NEW: computer (SSH config alias) to execute this turn's tools on. Omit = inherit (workspace default → local). */
  readonly computerId?: string;
}
```

`POST /chat` body parsing, the WS `chat.send` router (`handleChatSend`), and
`POST /conversations/:id/queue` (`QueueRequest`) all gain the optional
`computerId`, threaded identically to `cwd`/`workspaceId`.

### 9.4 No secret handling on the API

Per decision #3, there are **no secrets in the API at all** — keys live on disk
in `~/.ssh/` and are read by the `ssh` extension at connect time. There is no
`secretRef` field anywhere. This entire concern is removed relative to the
earlier draft.

---

## 10. Frontend impact (dispatch-web / worktrees/ssh-support/frontend)

The frontend is a Svelte app; cwd is managed in `src/app/store.svelte.ts` and
`src/features/workspace/`. The changes mirror the cwd UI:

1. **Computer selector from discovered list** (new feature folder
   `src/features/computer/`): a dropdown populated by `GET /computers` (which
   parses `~/.ssh/config`), **no create/edit/delete UI** — to add a computer the
   user edits `~/.ssh/config`. Each entry shows alias + knownHost indicator.
   A "Test connection" button hits `POST /computers/:alias/test`.
2. **Per-conversation computer selector** — a `ComputerField.svelte` next to the
   existing `CwdField.svelte` in the workspace sidebar. A dropdown of the
   discovered computers + "Local (none)". Saves via
   `PUT /conversations/:id/computer`.
3. **Workspace default computer** — in the workspace settings, a
   `default-computer` selector (mirror the `default-cwd` control). Saves via
   `PUT /workspaces/:id/default-computer`.
4. **Connection status badge** — near the computer selector, showing the live
   `state` from `GET /computers/:alias/status`
   (connected/connecting/error/offline). Poll or surface via the existing
   surface-registry mechanism.
5. **Store** (`store.svelte.ts`) gains `computerId` reactive state +
   `setComputer`/`refetchComputer` (parallel to `cwd`/`setCwd`).
6. **`chat.send`** — the chat store's `send()` does not currently pass cwd per-
   send (cwd is persisted, not per-message). `computerId` follows the same model
   (decision #5): persisted per-conversation, set via the sidebar, NOT per-
   message. So `chat.send` needs no change for the MVP (computer is resolved
   server-side from the persisted value). A per-send `computerId` override is a
   later option (the contract supports it; the UI need not expose it initially).
7. **(Roadmap) Host-key approve prompt** — on first connect to a new host, a
   FE prompt to approve the host key before it is pinned (decision #2 roadmap).
   Not in MVP; MVP auto-trusts-and-pins silently.

> **Transparency note for the FE:** the FE shows the computer to the *user* (so
> they know where commands run), but the *agent* never sees it (not in the system
> prompt, not in tool descriptions). The FE computer selector is a user-facing
> control, not an agent-facing one.

---

## 11. New packages / units summary

| New package | Tier | Owns | Depends on |
|---|---|---|---|
| `exec-backend` | core | `ExecBackend` contract, `LocalExecBackend`, `execBackendHandle` service, the resolver wiring | kernel |
| `ssh` | standard | `SshConnectionPool`, `SshExecBackend`, `~/.ssh/config` reader (uses `ssh-config`), `known_hosts` host-key verify, key read from `~/.ssh` | exec-backend, conversation-store (reads `getEffectiveComputer`), wire |

> **No `computer-store` package** (decision #4): with no `Computer` entity to
> CRUD, the config reader lives in `ssh`, and the persisted assignment +
> `getEffectiveComputer` live in the existing `conversation-store` (§3.4).

Modified units (contract changes, reported to owners — planner does NOT edit
these directly per one-owner-per-unit):

| Unit | Change |
|---|---|
| `kernel` (contracts) | `+ computerId` on `ToolExecuteContext` + `RunTurnInput` (additive optional) |
| `kernel` (runtime dispatch) | thread `computerId` through `executeToolCall`/`createStepDispatcher` |
| `wire` | `+ Computer`, `ComputerEntry` (read-only view); `+ defaultComputerId` on `Workspace` |
| `conversation-store` | `+ defaultComputerId` on `WorkspaceRow`/`Workspace` + `setWorkspaceDefaultComputerId`; `+ getComputerId`/`setComputerId`/`getEffectiveComputer` (mirrors cwd) |
| `tool-shell` | factory takes `resolveBackend`; `execute` uses `backend.spawn` |
| `tool-read-file` | refactor to `backend.readFile/readdir/stat` |
| `tool-write-file` | refactor to `backend.access/stat/writeFile` |
| `tool-edit-file` | refactor to backend fs ops |
| `session-orchestrator` | `+ computerId` on `StartTurnInput`/`TurnLifecyclePayload`; resolve `effectiveComputer`; thread into `RunTurnInput`; tools-filter drops `lsp`/`mcp` when remote |
| `transport-contract` | `+ computerId` on `ChatRequest`/`ChatSendMessage`/`QueueRequest`; computer (read-only) + workspace-computer response types |
| `transport-http` | read-only `/computers` (parses config) + status/test; per-conv/workspace-computer endpoints; thread `computerId` in `/chat` |
| `transport-ws` | thread `computerId` in `handleChatSend`/`handleChatQueue` |
| `host-bin` | wire `exec-backend` + `ssh` extensions; inject `resolveBackend` into tool extensions |
| `cache-warming` | thread `computerId` into warm tool assembly (cache-safe) |
| frontend | discovered-computer selector + per-conv/workspace-default selectors + status badge |

---

## 12. Implementation phases

### Phase 0 — Contracts (no behavior change)
- Add `computerId` to `ToolExecuteContext` + `RunTurnInput` (kernel contracts).
- Add `Computer`/`ComputerEntry` + `Workspace.defaultComputerId` to `@dispatch/wire`.
- Add `ExecBackend` contract + `execBackendHandle` in a new `exec-backend`
  package; `LocalExecBackend` wraps today's node calls (behavior-identical).
- Thread `computerId` through dispatch runtime (forwards `undefined` → no-op).
- **Verify:** `bun run typecheck` + `bun run test` green, behavior unchanged.

### Phase 1 — Refactor tools behind `ExecBackend` (still local-only)
- `tool-shell`/`read-file`/`write-file`/`edit-file` factories take
  `resolveBackend`; `LocalExecBackend` injected. Pure logic untouched.
- `host-bin` wires the local resolver.
- **Verify:** full test suite green; tools behave identically (this de-risks
  the refactor before any SSH).

### Phase 2 — Assignment + API (no SSH yet)
- `conversation-store`: `defaultComputerId` field + setter +
  `getComputerId`/`setComputerId`/`getEffectiveComputer` (mirrors cwd).
- transport-http/ws: read-only `/computers` + per-conv/workspace-computer
  endpoints + `computerId` on chat.
- `session-orchestrator`: resolve + thread `computerId`.
- **Verify:** can assign a computer (alias) per-conversation/workspace; with no
  `ssh` extension loaded, a configured computer yields a clear "no SSH backend"
  error (degraded) — local conversations unchanged.

### Phase 3 — SSH execution
- **First:** verify `ssh2` runs under Bun (load-bearing — decision #1).
- `ssh` package: `~/.ssh/config` reader (`ssh-config`), `SshConnectionPool`,
  `SshExecBackend` (ssh2 exec + sftp), key read from `~/.ssh`, host-key
  auto-trust-and-pin via `~/.ssh/known_hosts`, error mapping.
- `exec-backend` resolver returns `SshExecBackend` for a `computerId` (alias).
- tools-filter drops `lsp`/`mcp` on remote turns (silent — decision #6).
- **Verify:** integration test against a real (or dockerized) sshd — run_shell,
  read_file, write_file, edit_file execute remotely; agent is unaware.

### Phase 4 — Frontend
- Discovered-computer selector (from `GET /computers`), per-conv +
  workspace-default selectors, status badge.
- Wire store + chat flow (persisted per-conversation — decision #5).

### Phase 5 — Hardening
- Connection drop/offline/timeout edge tests.
- Idle reaping + keep-alive tuning.
- Observability spans for remote ops.
- (Roadmap) FE host-key approve prompt (decision #2).
- Remote LSP/MCP (future — out of scope for initial feature).

---

## 13. Open questions / decisions for the user

### Resolved (2026-06-25) — all decisions locked

1. ~~ssh2 vs bun-ssh2~~ → **`ssh2`** (no fork); verify under Bun at Phase 3 start.
2. ~~Host-key trust model~~ → **auto-trust-and-pin**; FE approve prompt is
   roadmap (future), not MVP.
3. ~~Auth method~~ → **key-only, from `~/.ssh/`** (no secrets/gopass).
4. ~~`Computer` storage location~~ → **moot**: no CRUD entity; computers are
   discovered read-only from `~/.ssh/config`. Assignment (alias string) lives in
   `conversation-store`.
5. ~~Per-send vs persisted `computerId`~~ → **persisted per-conversation**.
6. ~~Remote LSP/MCP scope~~ → **silently dropped** on remote turns (MVP); remote
   spawn is a future phase.
7. ~~`edit_file` diagnostics on remote~~ → **works, no diagnostics** (existing
   no-LSP degradation path).
8. ~~`ssh-config` dependency vs hand-rolled parser~~ → **take `ssh-config`**
   (project-local dep in `packages/ssh/package.json`, alongside `ssh2`). Both
   maintainers are single-author but these are the standard, widely-depended-on
   packages for their jobs (`ssh2` ~2k dependents; `ssh-config` ~224k weekly
   downloads). Correct config parsing (wildcards, `Include`, `Match`,
   first-match-wins) is worth the dep over a hand-rolled parser that would miss
   edge cases.

**No open questions remain.** The plan is decision-complete and ready to hand
off to implementation.

### Minor defaults adopted (not flagged as decisions — veto if undesired)

- The `~/.ssh/config` reader lives **inside the `ssh` extension** (it owns the
  SSH concern end-to-end).
- A stale alias (removed from `~/.ssh/config` while a conversation still points
  at it) is surfaced by the FE as **"unresolved"**, never silently falls back
  to local.
- Default identity file probing order: `~/.ssh/id_ed25519` → `~/.ssh/id_rsa` →
  others, first-existing-wins (matches OpenSSH's own probing).
- Encrypted-key passphrases: assume **unencrypted** for the MVP; passphrase
  prompting is bundled into the same FE roadmap item as the host-key approve
  prompt (decision #2).

---

## 14. Glossary additions (proposed, for `GLOSSARY.md`)

| Term | Meaning | Aliases to avoid |
|---|---|---|
| **computer** | A named SSH target, auto-discovered from a `Host` alias in the system's `~/.ssh/config` (read-only — NOT a persisted CRUD entity). Referenced by `computerId` (the alias). `null`/absent = local execution (no SSH). | host (when meaning the SSH target — clashes with "host" the runtime), remote, machine |
| **ExecBackend** | The transport-agnostic spawn+fs abstraction tools program against. Two implementations: `LocalExecBackend` (node) and `SshExecBackend` (ssh2). Resolved per-call from `ToolExecuteContext.computerId`. | backend, executor |
| **computerId** | The SSH config `Host` alias of the computer a turn's tools execute on. Threaded like `cwd` (per-turn override → persisted per-conversation → workspace `defaultComputerId` → `null`/local). | hostId, machineId, remoteId |
| **defaultComputerId** | A workspace's default computer (an SSH config alias), inherited by conversations with no per-conversation `computerId`. The computer analog of `defaultCwd`. | — |
