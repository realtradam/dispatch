import type { Extension, Logger } from "@dispatch/kernel";

/**
 * Load external (out-of-repo) extensions by dynamic import.
 *
 * Each specifier is a module the host imports at boot: an absolute path to a
 * built/source entry, or a package name resolvable from the host's working
 * directory. The module must expose an `Extension` as `export const extension`
 * (or as its default export). The host's own loader (`createHost`) then applies
 * apiVersion gating, dependency ordering, the capability gate, and per-extension
 * fault isolation — external extensions get exactly the same treatment as
 * bundled ones.
 *
 * Fault-isolated by design: a specifier that fails to import or exports no valid
 * extension is logged and SKIPPED — a broken external extension must never crash
 * boot (defend faults, not adversaries; never leave the system broken).
 *
 * Validation asymmetry (plan 04, §4.1 — on record): env-loaded externals get
 * ONLY the `isExtension` structural check below; plugins discovered via the
 * plugins-directory scan get the full `validatePluginManifest`. Externals are
 * a trusted, explicit, developer-loaded mechanism — NOT user drop-ins — so
 * the light check is deliberate. The one loudness concession: a missing or
 * invalid `tier` (a REQUIRED manifest field since plan 02) logs a warning
 * here. The external plugins referenced in the plan (provider-anthropic,
 * provider-openai, auth-claude, auth-codex) live OUTSIDE this repo — their
 * manifests must carry `tier` in tandem with plan 02.
 */
export async function loadExternalExtensions(
  specifiers: readonly string[],
  logger: Logger,
): Promise<Extension[]> {
  const loaded: Extension[] = [];
  for (const spec of specifiers) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const candidate = mod.extension ?? mod.default ?? mod;
      if (isExtension(candidate)) {
        // Runtime check for the post-plan-02 required `tier` field — a
        // warning only (see the asymmetry note above), never a boot failure.
        const tier = candidate.manifest.tier as unknown;
        if (tier !== "core" && tier !== "providers" && tier !== "standard") {
          logger.warn(
            `External extension "${candidate.manifest.id}" has no valid manifest tier (expected "core" | "providers" | "standard") — required since plan 02; directory-scanned plugins would fail validation for this`,
          );
        }
        loaded.push(candidate);
        logger.info(`Loaded external extension "${candidate.manifest.id}" from ${spec}`);
      } else {
        logger.warn(`External module "${spec}" has no valid extension export; skipped`);
      }
    } catch (err) {
      logger.error(`Failed to load external extension "${spec}"; skipped`, { err });
    }
  }
  return loaded;
}

/**
 * Structural check that a dynamically-imported value is an `Extension`
 * (id + activate present). Exported for the plugins-directory loader
 * (`plugin-discovery.ts`) so both import paths share the same check.
 */
export function isExtension(value: unknown): value is Extension {
  if (!value || typeof value !== "object") return false;
  const e = value as { manifest?: unknown; activate?: unknown };
  if (typeof e.activate !== "function") return false;
  const m = e.manifest as { id?: unknown } | undefined;
  return !!m && typeof m.id === "string";
}
