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
(`"eager"` at boot), `entry`, `frontend` (plan 03 — a prebuilt ESM frontend
module; see Step 7).

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

## Step 7 — Frontend modules (plan 03): the frontend ABI

A plugin MAY ship a **frontend module** — ONE prebuilt ESM file the web client
dynamically imports at runtime, whose views render inside the app's tile tree.

### The manifest section

```json
{ "frontend": { "apiVersion": "^1", "entry": "frontend.js" } }
```

- `apiVersion` — the semver RANGE of frontend ABI versions you support. The
  HANDSHAKE: the client checks the range against its `FRONTEND_ABI_VERSION`
  (currently `"1"`). A mismatch lists the plugin as **"incompatible frontend
  plugin"** in the manager UI and your module is NEVER imported. `"^1"`
  tracks the v1 ABI.
- `entry` — the built ESM file, relative to your plugin directory. The
  backend serves it at `GET /plugins/:id/frontend` (404 when unloaded or
  disabled in the requesting client's active workspace — a disabled plugin's
  code is not fetchable).

### The module contract

Default-export `{ activate(api) }` — see `packages/plugin-scaffold/src/frontend.ts`
(the canonical, compiling reference):

- `api.registerView({ id, label, component, panelEligible? })` — register a
  view into the SAME registry the built-in views use. The host FORCES your
  plugin's `pluginId` attribution on every registration (you cannot
  misattribute). The returned disposer removes the view. The `id` is what a
  tile leaf's `view` field names — place the view via a layout plugin (plan
  02's layout-chat) or the panel dropdowns.
- `api.surfaces` — **surfaces are the data path** (the ui-contract
  philosophy): views get data via `getSpec`/`subscribe` and act via `invoke`
  against the backend surfaces your plugin's backend half declares — NEVER
  through app stores or internals.
- `api.logger` — a plugin-prefixed console.
- `activate` MAY return a **deactivate disposer** — run on unload/disable
  BEFORE the host's unregister-by-pluginId sweep (the sweep is the safety
  net, not the primary path). Keep it complete.

### The deactivate contract + the no-unfetch limitation (honest semantics)

On unload/disable the host runs your disposer and sweeps your views, so the
UI is IMMEDIATELY correct — but ESM **cannot be un-fetched**: your module's
bytes linger in the browser's module cache. Re-enabling re-runs `activate`
on the CACHED module (same URL ⇒ no re-fetch, closure state is fresh). A
backend-side `reload` changes the content bust (the entry's mtime, carried
in `GET /plugins`' additive `frontend.bust`) ⇒ a NEW import URL ⇒ a fresh
module instance. There is no hot-reload: to pick up new frontend code,
reload the plugin (new bust) — the client's next sync re-imports.

### The build (one file, svelte externalized)

Views are Svelte 5 (runes). Build with the scaffold's canned vite lib config
(`packages/plugin-scaffold/scaffold-frontend.config.ts` + `bun run
build:frontend`): ONE standalone ESM file with the whole `svelte` package
EXTERNALIZED. The host's import map resolves the output's bare `svelte` /
`svelte/internal/client` imports to the app's OWN Svelte 5 runtime — one
shared runtime. **Never bundle svelte**: two runtimes = broken cross-component
reactivity (verified by the plan-03 spike; the host build emits
`svelte-api`/`svelte-internal-client` runtime chunks for exactly this map).

Build rules the spike established:
- `compilerOptions: { discloseVersion: false }` (svelte 5.56 otherwise emits
  `svelte/internal/disclose-version` even in production compiles);
- never name a destructured prop `state` — svelte 5.56 mis-compiles the
  `$state` rune as a legacy auto-subscription of that prop;
- the verify-plugin harness FAILS a manifest whose `frontend.entry` does not
  resolve inside the plugin directory (run the build before shipping).

### Trust (documented, no sandbox)

Frontend plugin code runs with FULL page privileges — there is no
sandboxing/iframe/CSP isolation in v1 (a documented non-goal, consistent
with backend plugins running in-process). The trust signal is the manifest's
`trust` field (`bundled` / `local` / `external`), rendered in the manager UI.

## Step 8 — Layout ops (plan 04): editing the workspace tree

Your plugin can EDIT the active layout instead of replacing it. The op
vocabulary lives in `@dispatch/layout-contract` (pure, serialisable data —
the same shapes the frontend renderer emits); the ACTIVE layout provider
(whichever plugin provides `layoutProviderHandle`, e.g. `layout-chat`)
applies them ATOMICALLY. Import both handles from
`@dispatch/layout-provider-contract`.

### The vocabulary + the ensure-first pattern

```ts
import { layoutProviderHandle } from "@dispatch/layout-provider-contract";
import type { LayoutOp } from "@dispatch/layout-contract";

const ops: readonly LayoutOp[] = [
  // ENSURE-FIRST: idempotent ops are the composition primitive. Re-activate,
  // reload, multi-client race → the panel is added exactly once.
  { type: "ensurePanel", panels: "side", view: "your-view-id" },
];
```

`replaceView` / `insertLeaf` / `insertPanel` / `removeNode` / `moveNode` /
`setSizes` / `splitLeaf` are the surgical edits; `ensureLeaf` / `ensurePanel`
are their idempotent counterparts. A blind `insert*` on every activation
duplicates panels; `ensure*` cannot.

### Address by ID, never by numeric path

Paths (`[1, 0]`) shift every time the tree is edited; ids are stable. The
default tree's ids — `"root"` (the main split), `"main"` (the left stack),
`"side"` (the right panels node) — are part of its contract. Target those:
`{ type: "ensurePanel", panels: "side", … }`.

### The provider may be absent — consume reactively

`layoutProviderHandle` is provided by a STANDARD plugin that may not be
loaded. NEVER `getService` it (that throws) — consume it like the scaffold
does (`packages/plugin-scaffold/src/extension.ts`, section 4d):

- `host.tryGetService(layoutProviderHandle)` → present? apply now.
- absent → `host.onServiceAvailable(layoutProviderHandle, cb)` and apply in
  the callback when a provider loads. Dispose the subscription in
  `deactivate()` (it is a ledger-tracked registration).
- absent forever → your ops never run; degrade gracefully (ephemeral
  frontend layouts are the no-provider mode).

### Atomicity + failure handling

`applyOps(workspaceId, ops)` returns
`{ ok: true, tree, applied } | { ok: false, error, failedOp }` — it NEVER
throws for bad ops. The whole batch is atomic: the ops fold over the tree as
read at apply time, the folded result validates, and only then does it
persist + broadcast ONCE. A failure (at `failedOp`) persists NOTHING. Tread
`!result.ok` as log-worthy, not crash-worthy. Concurrency is
last-writer-wins (no CAS in v1) — trees are small and edits are rare.

### Changes are events; tolerate your own writes

After every successful write (set / ops / reset) the provider emits the
`layoutChanged` hook (payload `{ workspaceId, tree }`); the WS broadcasts it
to every client. React with `host.on(layoutChanged, cb)` (dispose in
`deactivate()`); there is no caller attribution, so your reactor WILL see
your own writes — compare trees before re-asserting if a loop matters.

### NO-REVERT on unload + the reset affordance (documented semantics)

Unloading your plugin does NOT revert its layout edits — the edits are
permanent changes to the workspace tree (later edits may have built on them;
a revert graph is unbounded). `deactivate()` must NOT try to "remove my
panel". Recovery is the user-facing **"Reset layout to default"** button in
the workspace plugins modal (`DELETE /workspaces/:id/layout` → re-seed →
broadcast) — the plugins modal is where users manage layout plugins, and it
is the ONLY reset affordance. Note the asymmetry: unloading the *provider*
plugin removes persistence (clients fall back to the built-in default),
while unloading an *op-writing* plugin leaves its edits behind. Both are
intended.
