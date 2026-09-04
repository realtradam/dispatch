/**
 * plugin-scaffold — the CANONICAL example plugin (plan 08 §8.1).
 *
 * This file is the reference a plugin author copies. It is a real workspace
 * package that `tsc -b` typechecks in CI, and it doubles as the verify-plugin
 * harness's integration fixture — so it can never drift from the machinery:
 * if the extension model changes, this file fails to compile or fails
 * `verifyPlugin` loudly (see `packages/plugin-verify`).
 *
 * It demonstrates the complete, minimal lifecycle contract:
 * - a FULL `manifest` (every required field, `tier: "standard"`, one comment
 *   per field — see below),
 * - an `activate(host)` that contributes ONE tool + ONE service + ONE surface,
 * - a `deactivate()` that disposes everything it registered (the disposal
 *   contract: register → tracked → dispose).
 *
 * Copy this file, rename `plugin-scaffold` → your plugin id, and delete what
 * you don't need. Run the harness against your copy:
 * `bun packages/plugin-verify/src/cli.ts <your-package-dir>`.
 */

import type { Extension, HostAPI, Manifest, ServiceHandle, ToolContract } from "@dispatch/kernel";
import { defineService } from "@dispatch/kernel";
import type { SurfaceProvider } from "@dispatch/surface-registry";
import { surfaceRegistryHandle } from "@dispatch/surface-registry";

// ── 1. The service you contribute ────────────────────────────────────────────
//
// A service is a typed, single-responder capability other extensions consume
// through this handle (`host.getService(scaffoldServiceHandle)`). The id
// string lives in EXACTLY one place — this `defineService` call — and every
// consumer imports this symbol (never the raw string), so `lsp references`
// finds every consumer when the contract changes (AGENTS.md).

/** The typed contract of the service this plugin provides. */
export interface ScaffoldService {
  /** Build a greeting — the minimal interesting capability. */
  readonly greet: (name: string) => string;
}

/** The typed handle other code imports to consume the service. */
export const scaffoldServiceHandle: ServiceHandle<ScaffoldService> = defineService<ScaffoldService>(
  "plugin-scaffold/greeting",
);

// ── 2. The tool you contribute ───────────────────────────────────────────────
//
// A tool is what the MODEL calls during a turn. The kernel routes by `name`
// and calls `execute` with parsed input. Tools have NO extension-side
// removal — on unload the HOST removes them for you (you never dispose a
// tool; the host's registration ledger sweeps it).

function createScaffoldTool(): ToolContract {
  return {
    // The unique name the model uses. Namespace it with your plugin id.
    name: "scaffold_echo",
    description: "Echo the input back. The scaffold plugin's example tool.",
    // Structural JSON-Schema-ish declaration (no zod needed).
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo back." },
      },
      required: ["text"],
    },
    // Return { content, isError? }. Never throw — report errors via isError
    // so the model can react.
    execute: async (args) => {
      const text = (args as { text?: unknown }).text;
      if (typeof text !== "string" || text.length === 0) {
        return { content: 'Error: "text" must be a non-empty string.', isError: true };
      }
      return { content: text };
    },
  };
}

// ── 3. The manifest — every field, commented ─────────────────────────────────

export const manifest: Manifest = {
  // REQUIRED. Unique identifier across ALL loaded plugins. Use kebab-case;
  // the per-workspace enablement store (plan 06) and the plugin manager key
  // everything by this id.
  id: "plugin-scaffold",

  // REQUIRED. Human-readable display name (plugin manager UI, logs).
  name: "Plugin Scaffold",

  // REQUIRED. YOUR plugin's own version (semver) — not the kernel's.
  version: "0.0.0",

  // REQUIRED. Semver RANGE of kernel API versions you are compatible with.
  // "^0.1.0" tracks the current kernel (KERNEL_API_VERSION). A mismatch
  // disables your plugin with a reason at boot (never a crash).
  apiVersion: "^0.1.0",

  // REQUIRED. Which of the three tiers you belong to:
  //   "core"      — load-bearing infrastructure (storage, transports). Core
  //                 depends ONLY on core — a core→standard dependency is a
  //                 classification bug (assertNoCoreToStandardDeps fails it).
  //   "providers" — model provider extensions.
  //   "standard"  — everything else (tools, features, surfaces). THIS one,
  //                 unless you are literally storage/transport infra.
  tier: "standard",

  // REQUIRED. Where the code comes from: "bundled" (shipped in-repo),
  // "local" (project directory), or "external" (downloaded).
  trust: "bundled",

  // OPTIONAL. Ids of plugins you depend on — resolved topologically, so you
  // activate AFTER them. Declare every plugin whose service you `getService`;
  // an unmet dependency disables your plugin with a reason (never a crash).
  // The surface registry is a CORE plugin that is always loaded.
  dependsOn: ["surface-registry"],

  // OPTIONAL. What you contribute — DECLARE what your activate() registers,
  // so manifests stay machine-readable for discovery and gating. NOTE: there
  // is no "surfaces" key — surfaces ride on the surface-registry SERVICE (see
  // activate below), which is why they are NOT tracked by the host's disposal
  // ledger and must be deregistered by hand in deactivate().
  contributes: {
    tools: ["scaffold_echo"],
    services: ["plugin-scaffold/greeting"],
  },

  // OPTIONAL. Capabilities you need from the host (fs, shell, network,
  // secrets, db, spawn). Declare only what you use.
  capabilities: { network: false },

  // OPTIONAL. "eager" = activate at boot. Lazy event triggers are declared
  // as a string; keep "eager" unless you know you need otherwise.
  activation: "eager",

  // OPTIONAL (plan 03 — the frontend ABI): ship a prebuilt ESM frontend
  // module the web client imports at runtime. `apiVersion` is the semver
  // RANGE of frontend ABI versions you support (the handshake: it must
  // include the host's FRONTEND_ABI_VERSION = "1", so "^1" tracks v1);
  // `entry` is the built module file, relative to the plugin directory —
  // build it with `bun run build:frontend` (the vite lib config next to
  // this file, svelte fully externalized). The module default-exports
  // `{ activate(api) }` — see `src/frontend.ts`.
  frontend: { apiVersion: "^1", entry: "frontend.js" },
};

// ── 4. The extension — activate / deactivate ─────────────────────────────────

export function createScaffoldExtension(): Extension {
  // Disposers captured at activate time, called in deactivate(). EVERY
  // registration that hands you a disposer (provideService, registry.register,
  // host.on, host.addFilter, onServiceAvailable/Unavailable, scheduler jobs)
  // must have its disposer called here. The host force-cleans leftovers and
  // reports them as `dangling` on UnloadResult — verify-plugin fails loudly
  // on any dangling registration, so keep this list complete.
  let disposeService: (() => void) | undefined;
  let disposeSurface: (() => void) | undefined;

  return {
    manifest,

    // activate receives the Host API — the ONLY object through which you
    // register capabilities or reach host services.
    activate(host: HostAPI) {
      // 4a. Contribute the tool. No disposer — the host sweeps tools on unload.
      host.defineTool(createScaffoldTool());

      // 4b. Provide the service. `provideService` returns the un-provide
      // disposer — keep it.
      disposeService = host.provideService(scaffoldServiceHandle, {
        greet: (name) => `Hello, ${name}! (from plugin-scaffold)`,
      });

      // 4c. Contribute a surface. Surfaces are SERVICE-MEDIATED: you fetch
      // the surface registry (a core service, via its typed handle) and
      // register a provider. The returned disposer is your ONLY cleanup —
      // the host's ledger CANNOT see this registration, so a leaked surface
      // would never show up as `dangling`; verify-plugin checks the
      // registry's catalog for exactly this.
      const registry = host.getService(surfaceRegistryHandle);

      // Per-provider state lives in the activate closure — it dies with the
      // extension instance (no ambient/module-level state, AGENTS.md).
      let greetings = 0;

      const provider: SurfaceProvider = {
        // Discovery metadata. `pluginId` MUST be your manifest id — the
        // per-workspace catalog filter (plan 06) uses it to hide this
        // surface where your plugin is not enabled.
        catalogEntry: {
          id: "plugin-scaffold",
          region: "side",
          title: "Plugin Scaffold",
          scope: "global",
          pluginId: "plugin-scaffold",
        },
        // The data the client renders — structure + semantics, never styling.
        getSpec() {
          return {
            id: "plugin-scaffold",
            region: "side",
            title: "Plugin Scaffold",
            fields: [
              { kind: "stat", label: "Greetings sent", value: String(greetings) },
              { kind: "button", label: "Greet", action: { actionId: "greet" } },
            ],
          };
        },
        // Handle the actions your fields declared.
        invoke(actionId) {
          if (actionId === "greet") greetings += 1;
        },
      };

      disposeSurface = registry.register(provider);

      host.logger.info("plugin-scaffold activated");
    },

    // deactivate runs on unload / reload / shutdown. Dispose EVERYTHING you
    // registered, in the order you registered it. Tools, providers, and auth
    // have no extension-side removal — the host removes those for you.
    deactivate() {
      disposeSurface?.();
      disposeService?.();
    },
  };
}

/** The scaffold instance — what a host (or a test) loads. */
export const extension: Extension = createScaffoldExtension();
