import type { Extension, Manifest } from "@dispatch/kernel";
import type { ExecBackend } from "./backend.js";
import { localExecBackend } from "./local.js";
import type { ExecBackendResolver } from "./service.js";
import { execBackendHandle } from "./service.js";

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
 * The resolver provided by this extension.
 *
 * - `computerId` undefined → `LocalExecBackend` (today's local behavior).
 * - `computerId` set → throws. Remote execution is wired by `host-bin` + the
 *   `ssh` package in a later wave (`SshExecBackend` implements the same
 *   `ExecBackend` interface). For now only the local path exists — failing
 *   loudly here is safer than silently running locally when remote was requested.
 */
function resolveBackend(computerId?: string): ExecBackend {
	if (computerId === undefined) return localExecBackend;
	throw new Error(
		`Remote execution (computerId="${computerId}") is not yet configured. ` +
			"The SSH backend will be wired by the ssh package.",
	);
}

/**
 * Factory: create the `exec-backend` core extension.
 *
 * `activate` provides the local-only `ExecBackendResolver` via the typed
 * service handle. Remote resolution is added in a later wave.
 */
export function createExecBackendExtension(): Extension {
	return {
		manifest,
		activate(host) {
			const resolver: ExecBackendResolver = resolveBackend;
			host.provideService(execBackendHandle, resolver);
		},
	};
}
