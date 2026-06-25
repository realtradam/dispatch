import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import type { ExecBackend } from "./backend.js";
import { localExecBackend } from "./local.js";
import {
	type ExecBackendResolver,
	execBackendHandle,
	remoteExecBackendFactoryHandle,
} from "./service.js";

export const manifest: Manifest = {
	id: "exec-backend",
	name: "Exec Backend",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	activation: "eager",
	contributes: { services: ["exec-backend/resolver"] },
};

/**
 * Build the `ExecBackendResolver` for a given host.
 *
 * - `computerId` undefined → `localExecBackend` (byte-identical local path;
 *   no host lookup, no remote machinery — unchanged from the original behavior).
 * - `computerId` set → remote: lazily look up the factory the `ssh` extension
 *   provides via `remoteExecBackendFactoryHandle` and call it with the alias.
 *   The lookup is deferred to resolve time (tool-EXECUTE time, after every
 *   extension has activated), so a missing provider (ssh not loaded) degrades
 *   gracefully into a clear error instead of crashing activation. This mirrors
 *   the lazy `host.getService(lspServiceHandle)` try/catch pattern `tool-edit-file`
 *   uses for its diagnostics hook.
 *
 * The resolver stays SYNCHRONOUS and side-effect-free with respect to
 * connections: looking up the factory and calling it returns a backend whose
 * methods are async, so any remote connection acquisition happens lazily
 * inside the first backend method call, not at resolve time.
 */
function createResolver(host: HostAPI): ExecBackendResolver {
	return (computerId?: string): ExecBackend => {
		if (computerId === undefined) return localExecBackend;
		// computerId set → remote. Look up the factory the `ssh` extension provides.
		// `host.getService` throws when nothing provided the handle (ssh not loaded);
		// convert that into a clear "not configured" error rather than a crash.
		let factory: (computerId: string) => ExecBackend;
		try {
			factory = host.getService(remoteExecBackendFactoryHandle);
		} catch {
			throw new Error(
				`SSH remote execution is not configured: the ssh extension is not loaded ` +
					`(requested computerId="${computerId}"). Load the ssh package to enable remote execution.`,
			);
		}
		return factory(computerId);
	};
}

/**
 * Factory: create the `exec-backend` core extension.
 *
 * `activate` captures the host and provides the `ExecBackendResolver` via the
 * typed service handle. The resolver lazily delegates the remote branch to a
 * factory the `ssh` extension will provide (see `remoteExecBackendFactoryHandle`);
 * until `ssh` is loaded, a remote request fails with a clear error.
 */
export function createExecBackendExtension(): Extension {
	return {
		manifest,
		activate(host) {
			const resolver: ExecBackendResolver = createResolver(host);
			host.provideService(execBackendHandle, resolver);
		},
	};
}
