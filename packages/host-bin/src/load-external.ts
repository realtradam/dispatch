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

/** Structural check that a dynamically-imported value is an `Extension`. */
function isExtension(value: unknown): value is Extension {
	if (!value || typeof value !== "object") return false;
	const e = value as { manifest?: unknown; activate?: unknown };
	if (typeof e.activate !== "function") return false;
	const m = e.manifest as { id?: unknown } | undefined;
	return !!m && typeof m.id === "string";
}
