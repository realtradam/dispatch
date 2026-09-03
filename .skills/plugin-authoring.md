Author a correct Dispatch plugin (extension) from scratch — manifest, activate/deactivate lifecycle, disposal contract, and passing the verify-plugin gate; use this whenever you create or edit a plugin, tool extension, or service-providing extension in this repo.
---
# Plugin authoring

A **plugin** is the packaged form of an **extension** (GLOSSARY.md): a unit that
contributes capabilities — tools, providers, auth, hooks, services, surfaces —
through the **Host API** it receives in `activate(host)`. This skill is the
step-by-step procedure. The canonical, compiling reference is
`packages/plugin-scaffold/` — copy it and rename. If your plugin violates this
procedure it does not fail review; it fails **verify-plugin** loudly at test
time.

## Step 0 — Decide the shape

- What do you contribute? A **tool** (the model calls it), a **service** (typed,
  single-responder, other code consumes it via a `ServiceHandle`), a **surface**
  (backend data a client renders), a **provider** (an LLM backend), hooks
  (event/filter), or several of these.
- Which **tier**? `"standard"` for everything except load-bearing infrastructure
  (`"core"` — storage/transports; core depends ONLY on core) and model backends
  (`"providers"`). When in doubt: `"standard"`.

## Step 1 — Create the package

In-repo (bundled) plugins live as a real workspace package so CI typechecks
them (they can never drift from the machinery):

```
packages/<your-plugin>/
  package.json      # name "@dispatch/<your-plugin>", workspace deps
  tsconfig.json     # extends ../../tsconfig.base.json, composite, references
  src/index.ts      # public barrel (what other units may import)
  src/extension.ts  # the manifest + activate/deactivate
```

Add the package to: root `tsconfig.json` `references`, and (if it must load at
boot) the bundled set in `packages/host-bin/src/bundled.ts` — that file curates
NOTHING else; the host resolves activation order from the manifests'
`dependsOn` DAG, and array order is irrelevant.

Directory-packaged (runtime drop-in) plugins use the same code with a
`manifest.json` file at the plugin dir root instead of a TS manifest (same
fields, JSON) and default to the entry `index.ts`/`index.js` (`manifest.entry`
overrides).

## Step 2 — Write the manifest (every required field)

Copy the scaffold's manifest: it has one comment per field. The REQUIRED set
(missing any = compile error in TS, validation error in JSON):

| Field | Meaning |
|---|---|
| `id` | Unique kebab-case identifier — the plugin manager, the per-workspace enablement store, and tool attribution all key on it. |
| `name` | Human-readable display name. |
| `version` | YOUR plugin's semver (not the kernel's). |
| `apiVersion` | Semver RANGE of kernel API compatibility — `"^0.1.0"` tracks the current kernel (`KERNEL_API_VERSION`). A mismatch disables the plugin with a reason, never a crash. |
| `tier` | `"core" \| "providers" \| "standard"` (see Step 0). |
| `trust` | `"bundled"` (in-repo), `"local"`, or `"external"`. |

Optional fields: `dependsOn` (declare EVERY plugin whose service you
`getService` — the host resolves order topologically and refuses loads with
unmet deps with a reason), `contributes` (declare what your activate registers:
`tools`, `services`, … — machine-readable for discovery/gating), `capabilities`
(fs/shell/network/secrets/db/spawn — declare only what you use), `activation`
(`"eager"` at boot), `entry`, `frontend` (**reserved — do not set it**; frozen
shape, no runtime semantics yet).

Rules that are machine-enforced:

- **Core depends only on core** (AGENTS.md). A `core` plugin with a
  `dependsOn` edge to a `standard` plugin is a classification bug —
  `assertNoCoreToStandardDeps` throws, verify-plugin reports the exact edge.
- **Runtime plugins cannot contribute `migrations`** — the host collects
  migrations at `createHost()` time, before any runtime load.
- `tier`/`trust` values are validated at scan time and by the type-level
  fixtures in `packages/kernel/src/contracts/extension.typecheck.ts`.

## Step 3 — activate(host): register through the Host API

`activate` receives the **Host API** — the ONLY object through which you
register or reach anything. The scaffold contributes one of each kind:

- **Tool** — `host.defineTool(tool)`: `name` the model calls, structural JSON
  schema `parameters`, `execute(args, ctx) → { content, isError? }`. Never
  throw from execute — report via `isError`. Tools have NO extension-side
  removal: the host removes them for you on unload.
- **Service** — `host.provideService(handle, impl)`: declare the typed
  `ServiceHandle` with `defineService<T>("your-plugin/name")` and export it;
  consumers import the SYMBOL (never the raw string — AGENTS.md typed-handle
  rule). **Keep the returned disposer.**
- **Surface** — surfaces are SERVICE-mediated: `host.getService(surfaceRegistryHandle)`
  (a core service from `@dispatch/surface-registry`), then
  `registry.register(provider)`. Stamp `catalogEntry.pluginId` with your
  manifest id — the per-workspace catalog filter hides your surface where your
  plugin is not enabled. **Keep the returned disposer.** Surface registrations
  are INVISIBLE to the host's disposal ledger — see Step 4.

Consume services reactively when the provider might be absent: `tryGetService`
(→ undefined, degrade) instead of `getService` (throws). Prefer
`onServiceAvailable`/`onServiceUnavailable` slots for stateful consumers.

Per-call state lives in the activate closure — NO ambient/module state
(AGENTS.md). A module-scoped store (like the lsp extension's manager store) is
the accepted exception for `deactivate` reachability; keep it minimal.

## Step 4 — deactivate(): the disposal contract (register → tracked → dispose)

Everything that handed you a disposer must have it called in `deactivate()`:

- every `provideService` un-provide disposer,
- every `registry.register(provider)` unregister disposer (surfaces!),
- every `host.on` / `host.addFilter` / `onServiceAvailable` /
  `onServiceUnavailable` subscription/filter disposer,
- every `scheduler.register(job)` — call `scheduler.unregister(jobId)`.

Tools, providers, and auth need nothing — the host sweeps them. Anything you
leave behind is force-cleaned by the host and reported as `dangling` on
`UnloadResult`; a surface left behind never even shows there (it is not
ledger-tracked). BOTH are failures — verify-plugin catches them (Step 5).

## Step 5 — Verify: verify-plugin

```bash
# The full harness as a test (runs in `bun run test` — CI gate):
bun run test                          # packages/plugin-verify/src/verify.test.ts

# The runnable face, against a directory plugin:
bun packages/plugin-verify/src/cli.ts <your-plugin-dir>
```

`verifyPlugin` checks: **manifest** completeness (the plan-04 mirror: required
fields, tier/trust validity, parseable apiVersion), the **tier rule**
(core→standard edges, over your plugin plus `--set` context), and the
**disposal contract** in a throwaway host — load → unload → reload → unload
with ZERO dangling registrations and ZERO leaked surfaces (it reads the
surface-registry catalog after unload, because the ledger cannot see
surfaces). Every failure is a specific message naming the registration or
edge. Fix the named problem, re-run, commit.

## Step 6 — Wire it up (bundled plugins only)

1. Root `tsconfig.json` → add `{ "path": "./packages/<your-plugin>" }`.
2. `bun install` (links the new workspace package).
3. If it loads at boot: `packages/host-bin/src/bundled.ts` → import + add to
   the array (under the right tier comment; order is irrelevant).
4. Add it to `packages/host-bin/package.json` dependencies if bundled.
5. Consumers of your service: they import your exported `ServiceHandle` and
   `getService`/`tryGetService` — never a string lookup.

## Per-workspace enablement (what happens after you ship)

Bundled standard plugins boot INERT everywhere until a workspace opts in: the
per-workspace state is `undefined` (blank slate) and `undefined` behaves as
disabled for the standard/providers tiers (`isPluginUsable` in
`@dispatch/workspace-plugin-config`). Enabling your plugin for a workspace adds
YOUR tools to that workspace's turns (the plan-06 tool gate attributes every
tool to its owning plugin via the registration ledger); disabling removes them.
Nothing in your plugin code participates — this is the mechanism, not your
responsibility.
