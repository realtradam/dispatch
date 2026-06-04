import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { extension as authApikeyExt } from "@dispatch/auth-apikey";
import { extension as conversationStoreExt } from "@dispatch/conversation-store";
import {
	type ConfigAccess,
	createBus,
	createHost,
	type EventsEmitter,
	type Extension,
	type HostAPI,
	type HostDeps,
	type Logger,
	type PermissionGate,
	type ScheduledJob,
	type SecretsAccess,
	type StorageNamespace,
} from "@dispatch/kernel";
import { extension as providerOpenaiCompatExt } from "@dispatch/provider-openai-compat";
import { extension as sessionOrchestratorExt } from "@dispatch/session-orchestrator";
import { createSqliteStorage, extension as storageSqliteExt } from "@dispatch/storage-sqlite";
import { extension as toolReadFileExt } from "@dispatch/tool-read-file";
import { createServer, extension as transportHttpExt } from "@dispatch/transport-http";
import { configMapToAccess, envToConfigMap } from "./config.js";

function createConsoleLogger(): Logger {
	return {
		debug: (message: string, ...args: unknown[]) => console.debug(`[debug] ${message}`, ...args),
		info: (message: string, ...args: unknown[]) => console.info(`[info] ${message}`, ...args),
		warn: (message: string, ...args: unknown[]) => console.warn(`[warn] ${message}`, ...args),
		error: (message: string, ...args: unknown[]) => console.error(`[error] ${message}`, ...args),
	};
}

function createEmptySecrets(): SecretsAccess {
	return {
		get: async () => null,
		set: async () => {},
		delete: async () => {},
	};
}

function createAllowAllPermissions(): PermissionGate {
	return {
		check: async () => ({ allowed: true }),
	};
}

function createNoopScheduler(): { readonly register: (job: ScheduledJob) => void } {
	return { register: () => {} };
}

function createNoopEvents(): EventsEmitter {
	return { emit: () => {} };
}

function buildPostActivationHostAPI(
	host: {
		getProviders: () => ReadonlyMap<string, unknown>;
		getTools: () => ReadonlyMap<string, unknown>;
		getAuthProviders: () => ReadonlyMap<string, unknown>;
		getAuthProvider: (id: string) => unknown;
	},
	deps: HostDeps,
): HostAPI {
	const notAvailable = () => {
		throw new Error("Registration not available after activation");
	};
	return {
		defineTool: notAvailable,
		defineProvider: notAvailable,
		defineAuth: notAvailable,
		on: (hook, handler) => deps.bus.on(hook, handler),
		addFilter: (hook, fn) => deps.bus.addFilter(hook, fn),
		provideService: (handle, impl) => deps.bus.provideService(handle, impl),
		getService: (handle) => deps.bus.getService(handle),
		storage: (namespace: string) => deps.storageFactory(namespace),
		config: deps.config,
		secrets: deps.secrets,
		permissions: deps.permissions,
		events: deps.events,
		logger: deps.logger,
		getProviders: () => host.getProviders() as ReturnType<HostAPI["getProviders"]>,
		getTools: () => host.getTools() as ReturnType<HostAPI["getTools"]>,
		getAuthProviders: () => host.getAuthProviders() as ReturnType<HostAPI["getAuthProviders"]>,
		getAuthProvider: (id: string) =>
			host.getAuthProvider(id) as ReturnType<HostAPI["getAuthProvider"]>,
		scheduler: { register: (job: ScheduledJob) => deps.scheduler.register(job) },
	};
}

const CORE_EXTENSIONS: readonly Extension[] = [
	storageSqliteExt,
	conversationStoreExt,
	authApikeyExt,
	providerOpenaiCompatExt,
	toolReadFileExt,
	sessionOrchestratorExt,
	transportHttpExt,
];

async function boot(): Promise<void> {
	const logger = createConsoleLogger();

	const dbPath = process.env.DISPATCH_DB ?? "./.dispatch-data/dispatch.db";
	mkdirSync(dirname(dbPath), { recursive: true });
	const sqliteBackend = createSqliteStorage({ path: dbPath });
	const storageFactory = (namespace: string): StorageNamespace => sqliteBackend.storage(namespace);

	const configMap = envToConfigMap(process.env as Readonly<Record<string, string | undefined>>);
	const config: ConfigAccess = configMapToAccess(configMap);

	const deps: HostDeps = {
		logger,
		config,
		storageFactory,
		secrets: createEmptySecrets(),
		permissions: createAllowAllPermissions(),
		scheduler: createNoopScheduler(),
		bus: createBus(logger),
		events: createNoopEvents(),
	};

	const host = createHost(CORE_EXTENSIONS, deps);
	await host.activate();

	const disabled = host.getDisabled();
	if (disabled.length > 0) {
		for (const d of disabled) {
			logger.warn(`Extension "${d.manifest.id}" disabled: ${d.reason}`);
		}
	}

	const hostAPI = buildPostActivationHostAPI(host, deps);
	const app = createServer(hostAPI);

	// Port precedence: BACKEND_PORT (the rewrite's assigned port) → PORT → default.
	const port = Number(process.env.BACKEND_PORT) || Number(process.env.PORT) || 24203;
	const server = Bun.serve({ fetch: app.fetch, port });
	logger.info(`Dispatch listening on http://localhost:${server.port}`);
}

boot().catch((err) => {
	console.error("Fatal boot error:", err);
	process.exit(1);
});
