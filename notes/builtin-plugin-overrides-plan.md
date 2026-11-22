# Built-in plugins honor "off" across restarts — plan (feature/builtin-plugin-overrides)

User request (2026-11-22): disable the SSH plugin everywhere; then: "Make startup respect
'unloaded' records for built-in plugins … if we mark it as off, it should stay off until we enable it".

## Problem
`plugin-manager` writes an override record on unload ("stays unloaded across boots"), but host-bin
only applies records to plugin-DIRECTORY drop-ins. Built-ins (bundled set + DISPATCH_EXTERNAL_EXTENSIONS)
always load at boot, and an unloaded built-in shows as a "missing" row that cannot be loaded again.

## Design (Opus)
- host-bin: read override records BEFORE `createHost` (`storageFactory(PLUGIN_OVERRIDES_NAMESPACE)`
  == `hostApi.storage`); pure `partitionBuiltins` skips non-core built-ins with a record (core always
  loads, warn); engine exposes `getBuiltinManifests()` / `getBuiltinExtension(id)`; skipped
  built-ins are not logged as missing.
- plugin-manager: list shows a kept-off built-in as a `discovered` row (`dir: ""`, override info)
  instead of `missing`; `load(id)` falls back to the built-in instance (clears the record).
  unload/reload/forget unchanged.
- Contract: `PluginEngine` (plugin-manager engine.ts) +2 members; `transport-contract` 0.30.0 doc:
  `DiscoveredPluginRow.dir` is `""` for built-ins. FE needs no change (it never reads `dir`;
  discovered rows already have a load checkbox).
- Known limits: dependents of a kept-off built-in are disabled-with-reason by the host's DAG gate at
  boot and recover on the next restart after re-enabling; reload of a built-in stays unsupported.

## Rollout caveat (needs user decision before restart)
The live DB holds old "unloaded by user" records for plugins that are ON today because records were
ignored: auth-claude, auth-codex, cache-warming, heartbeat, layout-diagnostic, provider-anthropic,
provider-longcat, provider-openai. Under the fix they would turn OFF at the next restart (incl. the
Claude provider). Clear the ones that should stay on with `POST /plugins/<id>/forget` first.

## Units / waves
Wave 0 (Opus): engine.ts + transport-contract doc. Wave 1 (Flash, parallel): host-bin
(conv 068f7b64), plugin-manager (conv e0610fa2). Wave 2 (Opus): verify, private boot probe on a DB
copy, commit, ff-merge to dev on user request.
