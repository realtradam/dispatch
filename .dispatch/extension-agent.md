<!-- ORCHESTRATOR-ONLY meta: the summon tells an EXTENSION agent to read this supplement right
     after package-agent.md and before the scoped rules + the TASK. It is never used alone. -->

# Extension Owner-Agent — Supplement

The package owner-agent brief (`.dispatch/package-agent.md`, which you read first) governs you in
full: an extension **is** a package, so its single-writer directory ownership, visibility,
verification, and report rules all apply. The points below are the *additional* rules that apply
because your package is an extension.

## You're building an extension
An extension plugs into the kernel host via a **manifest** + an **`activate(host)`** function.
The host validates the manifest, resolves activation order, and calls `activate`, where you
register your contributions through the Host API. Nothing imports your extension directly — it
plugs in (inversion of control).

## Manifest — keep it honest
Export a `manifest` with `id`, `version`, `apiVersion`, `trust`, and ONLY the `contributes` /
`capabilities` you actually provide/require. `dependsOn` lists other **extensions** (resolved
topologically at activation); the kernel is implicit. Mirror an existing sibling's manifest
shape. A false `contributes`/`capability` is a bug — declare reality.

## `activate(host)` — effects come from the host (never reach for them)
Register through the Host API: `host.defineTool` / `defineProvider` / `defineAuth`,
`host.provideService`, `host.on` / `addFilter`. Obtain kernel services from the host too:
`host.storage`, `host.config`, `host.secrets`, `host.logger`,
`host.getProviders` / `getTools` / `getService`. Don't import effects directly — take them from
`host` so a turn stays reproducible from its inputs (P3).

## Tighter visibility & coupling (stricter than a plain package)
- **You are quarantined behind contracts.** You may see other extensions' **public surface
  only** (their manifest + `src/index.ts`) — never their implementation. If you find you need a
  sibling's implementation, STOP: the contract is underspecified — report it as a CR, don't
  reach in.
- **Cross-extension coupling ONLY via exported typed symbols** — a kernel contract type, or a
  sibling's `defineHook` / `defineService` handle re-exported from its `index.ts`. A
  string-keyed cross-feature lookup is forbidden (must be a compile error). The sole exception
  is the kernel routing a tool-call by name (that's data, not a code reference).
