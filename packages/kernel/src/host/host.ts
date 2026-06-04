import type { Bus } from "../bus/bus.js";
import type { AuthContract } from "../contracts/auth.js";
import type {
	ConfigAccess,
	EventsEmitter,
	Extension,
	HostAPI,
	Logger,
	Manifest,
	PermissionGate,
	ScheduledJob,
	SecretsAccess,
	StorageNamespace,
} from "../contracts/extension.js";
import type {
	EventHandler,
	EventHookDescriptor,
	FilterDescriptor,
	FilterHandler,
	ServiceHandle,
} from "../contracts/hooks.js";
import type { ProviderContract } from "../contracts/provider.js";
import type { ToolContract } from "../contracts/tool.js";
import { resolveActivationOrder } from "./dag.js";
import { isApiVersionCompatible } from "./version.js";

export const KERNEL_API_VERSION = "0.1.0";

export interface DisabledExtension {
	readonly manifest: Manifest;
	readonly reason: string;
}

export interface HostDeps {
	readonly logger: Logger;
	readonly config: ConfigAccess;
	readonly storageFactory: (namespace: string) => StorageNamespace;
	readonly secrets: SecretsAccess;
	readonly permissions: PermissionGate;
	readonly scheduler: { readonly register: (job: ScheduledJob) => void };
	readonly bus: Bus;
	readonly events: EventsEmitter;
}

export interface Host {
	readonly activate: () => Promise<void>;
	readonly deactivate: () => Promise<void>;
	readonly getTools: () => ReadonlyMap<string, ToolContract>;
	readonly getTool: (name: string) => ToolContract | undefined;
	readonly getProviders: () => ReadonlyMap<string, ProviderContract>;
	readonly getProvider: (id: string) => ProviderContract | undefined;
	readonly getAuthProviders: () => ReadonlyMap<string, AuthContract>;
	readonly getAuthProvider: (id: string) => AuthContract | undefined;
	readonly getScheduledJobs: () => readonly ScheduledJob[];
	readonly getMigrations: () => readonly string[];
	readonly getDisabled: () => readonly DisabledExtension[];
}

export function createHost(extensions: readonly Extension[], deps: HostDeps): Host {
	const tools = new Map<string, ToolContract>();
	const providers = new Map<string, ProviderContract>();
	const authProviders = new Map<string, AuthContract>();
	const scheduledJobs: ScheduledJob[] = [];
	const migrations: string[] = [];
	const disabled: DisabledExtension[] = [];
	const activated: Extension[] = [];

	const ordered = resolveActivationOrder(extensions.map((e) => e.manifest));
	const extById = new Map<string, Extension>();
	for (const ext of extensions) {
		extById.set(ext.manifest.id, ext);
	}

	const compatible: Extension[] = [];
	for (const m of ordered) {
		const ext = extById.get(m.id);
		if (ext === undefined) continue;
		if (isApiVersionCompatible(m.apiVersion, KERNEL_API_VERSION)) {
			compatible.push(ext);
		} else {
			disabled.push({
				manifest: m,
				reason: `apiVersion "${m.apiVersion}" is incompatible with kernel API ${KERNEL_API_VERSION}`,
			});
			deps.logger.warn(`Extension "${m.id}" disabled: apiVersion incompatible`);
		}
	}

	for (const ext of compatible) {
		const extMigrations = ext.manifest.contributes?.migrations;
		if (extMigrations) {
			for (const migration of extMigrations) {
				migrations.push(migration);
			}
		}
	}

	function buildHostAPI(): HostAPI {
		return {
			defineTool(tool: ToolContract) {
				tools.set(tool.name, tool);
			},
			defineProvider(provider: ProviderContract) {
				providers.set(provider.id, provider);
			},
			defineAuth(auth: AuthContract) {
				authProviders.set(auth.id, auth);
			},
			on<TPayload>(hook: EventHookDescriptor<TPayload>, handler: EventHandler<TPayload>) {
				return deps.bus.on(hook, handler);
			},
			addFilter<TValue>(hook: FilterDescriptor<TValue>, fn: FilterHandler<TValue>) {
				return deps.bus.addFilter(hook, fn);
			},
			provideService<T>(handle: ServiceHandle<T>, impl: T) {
				deps.bus.provideService(handle, impl);
			},
			getService<T>(handle: ServiceHandle<T>): T {
				return deps.bus.getService(handle);
			},
			storage(namespace: string): StorageNamespace {
				return deps.storageFactory(namespace);
			},
			config: deps.config,
			secrets: deps.secrets,
			permissions: deps.permissions,
			events: deps.events,
			logger: deps.logger,
			getProviders() {
				return providers;
			},
			getTools() {
				return tools;
			},
			getAuthProviders() {
				return authProviders;
			},
			getAuthProvider(id: string) {
				return authProviders.get(id);
			},
			scheduler: {
				register(job: ScheduledJob) {
					scheduledJobs.push(job);
					deps.scheduler.register(job);
				},
			},
		};
	}

	return {
		async activate() {
			for (const ext of compatible) {
				try {
					await ext.activate(buildHostAPI());
					activated.push(ext);
					deps.logger.info(`Extension "${ext.manifest.id}" activated`);
				} catch (err) {
					disabled.push({
						manifest: ext.manifest,
						reason: `Activation failed: ${err instanceof Error ? err.message : String(err)}`,
					});
					deps.logger.error(`Extension "${ext.manifest.id}" failed to activate`, err);
				}
			}
		},
		async deactivate() {
			for (let i = activated.length - 1; i >= 0; i--) {
				const ext = activated[i];
				if (ext === undefined || ext.deactivate === undefined) continue;
				try {
					await ext.deactivate();
				} catch (err) {
					deps.logger.error(`Extension "${ext.manifest.id}" failed to deactivate`, err);
				}
			}
		},
		getTools() {
			return tools;
		},
		getTool(name: string) {
			return tools.get(name);
		},
		getProviders() {
			return providers;
		},
		getProvider(id: string) {
			return providers.get(id);
		},
		getAuthProviders() {
			return authProviders;
		},
		getAuthProvider(id: string) {
			return authProviders.get(id);
		},
		getScheduledJobs() {
			return scheduledJobs;
		},
		getMigrations() {
			return migrations;
		},
		getDisabled() {
			return disabled;
		},
	};
}
