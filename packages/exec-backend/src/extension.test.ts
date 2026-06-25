import type { HostAPI, ServiceHandle } from "@dispatch/kernel";
import { describe, expect, it } from "vitest";
import type { ExecBackend } from "./backend.js";
import { createExecBackendExtension } from "./extension.js";
import { localExecBackend } from "./local.js";
import { execBackendHandle, remoteExecBackendFactoryHandle } from "./service.js";

/**
 * Resolver tests — pure core, zero internal mocks.
 *
 * The resolver's ONLY external dependency is `host.getService` (the service
 * registry — the outermost edge). We inject a minimal fake host that mirrors
 * the real `bus.getService` contract: returns the provided impl, or throws when
 * nothing provided the handle. No `vi.mock("@dispatch/*")` — the resolver +
 * handles + local backend under test are all real.
 *
 * Three cases (matching the task spec):
 *  1. `computerId` undefined → `localExecBackend` (byte-identical local path).
 *  2. `computerId` set + factory provided → the factory's backend.
 *  3. `computerId` set + factory NOT provided (ssh not loaded) → a clear
 *     "SSH remote execution is not configured" error, not a crash.
 */

/**
 * A minimal fake host exposing only the service-registry surface the resolver
 * touches (`getService`/`provideService`). Throws on a missing service exactly
 * like the real `bus.getService`, so the resolver's try/catch path is exercised
 * against behavior-equivalent input.
 */
function createFakeHost(services: Map<string, unknown>): HostAPI {
	const api = {
		provideService<T>(handle: ServiceHandle<T>, impl: T): void {
			services.set(handle.id, impl);
		},
		getService<T>(handle: ServiceHandle<T>): T {
			const impl = services.get(handle.id);
			if (impl === undefined) {
				throw new Error(
					`Service "${handle.id}" has no provider. Call provideService before getService.`,
				);
			}
			return impl as T;
		},
	};
	// The resolver only calls getService; the rest of HostAPI is unused here.
	return api as unknown as HostAPI;
}

/** A fake remote backend — identifiable so we can assert it's the one returned. */
function createFakeRemoteBackend(marker: string): ExecBackend {
	const fail = (): never => {
		throw new Error(`fake remote backend (${marker}) should not be called in this test`);
	};
	return {
		spawn: fail,
		readFile: fail,
		writeFile: fail,
		stat: fail,
		readdir: fail,
		exists: fail,
	};
}

describe("ExecBackend resolver", () => {
	it("returns localExecBackend for computerId === undefined (local path unchanged)", () => {
		const services = new Map<string, unknown>();
		const host = createFakeHost(services);

		// Activate the extension so it registers its resolver, then retrieve it.
		createExecBackendExtension().activate(host);
		const resolver = host.getService(execBackendHandle);

		expect(resolver(undefined)).toBe(localExecBackend);
		expect(resolver()).toBe(localExecBackend);
	});

	it("returns the factory's backend for a set computerId when the factory is provided", () => {
		const services = new Map<string, unknown>();
		const host = createFakeHost(services);

		// The `ssh` extension (not built yet) would do this:
		const remoteBackend = createFakeRemoteBackend("ssh-alias");
		const factory = (computerId: string): ExecBackend => {
			// Confirm the alias is threaded through to the factory.
			expect(computerId).toBe("ssh-alias");
			return remoteBackend;
		};
		host.provideService(remoteExecBackendFactoryHandle, factory);

		createExecBackendExtension().activate(host);
		const resolver = host.getService(execBackendHandle);

		expect(resolver("ssh-alias")).toBe(remoteBackend);
	});

	it("throws a clear 'not configured' error when the factory is NOT provided (ssh not loaded)", () => {
		const services = new Map<string, unknown>();
		const host = createFakeHost(services);

		// No remoteExecBackendFactoryHandle provided → simulates ssh not loaded.
		createExecBackendExtension().activate(host);
		const resolver = host.getService(execBackendHandle);

		// Not a crash: a clear, actionable error mentioning computerId + ssh.
		expect(() => resolver("some-host")).toThrow(/SSH remote execution is not configured/);
		expect(() => resolver("some-host")).toThrow(/ssh extension is not loaded/);
		expect(() => resolver("some-host")).toThrow(/some-host/);
	});

	it("local path is unaffected by whether the factory is provided", () => {
		// Even with a factory present, computerId === undefined still returns local.
		const services = new Map<string, unknown>();
		const host = createFakeHost(services);
		host.provideService(remoteExecBackendFactoryHandle, () => createFakeRemoteBackend("unused"));

		createExecBackendExtension().activate(host);
		const resolver = host.getService(execBackendHandle);

		expect(resolver(undefined)).toBe(localExecBackend);
	});
});
