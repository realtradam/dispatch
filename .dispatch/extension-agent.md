# Extension Owner-Agent — Extension Rules (additive)

> The package-agent brief (stated immediately above) applies fully. This file adds only the
> rules unique to extensions. Your **TASK** follows this section.

## You're building an extension
An extension is a package that plugs into the kernel host via a **manifest** + an
**`activate(host)`** function. The host validates the manifest, resolves the dependency order,
and calls `activate`, where you register your contributions through the Host API. Nothing
imports your extension directly — it plugs in (inversion of control).

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
`host` so the turn's behaviour stays reproducible from its inputs (P3).

## Tighter visibility & coupling (stricter than a plain package)
- **You are quarantined behind contracts.** You may read other extensions' **public surface
  only** (their manifest + `src/index.ts`) — **never** their implementation. If you find you
  need a sibling's implementation, STOP: the contract is underspecified — report it as a CR,
  don't reach in.
- **Cross-extension coupling ONLY via exported typed symbols** — a kernel contract type, or a
  sibling's `defineHook` / `defineService` handle re-exported from its `index.ts`. A
  string-keyed cross-feature lookup is forbidden (it must be a compile error). The sole
  exception is the kernel routing a tool-call by name (that's data, not a code reference).
