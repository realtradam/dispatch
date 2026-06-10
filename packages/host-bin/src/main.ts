import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { extension as authApikeyExt } from "@dispatch/auth-apikey";
import { extension as conversationStoreExt } from "@dispatch/conversation-store";
import { createCredentialStoreExtension } from "@dispatch/credential-store";
import { createJournalSink } from "@dispatch/journal-sink";
import {
	type ConfigAccess,
	createBus,
	createHost,
	createLogger,
	type EventsEmitter,
	type Extension,
	type HostDeps,
	type LogDeps,
	type PermissionGate,
	type ScheduledJob,
	type SecretsAccess,
	type StorageNamespace,
} from "@dispatch/kernel";
import { extension as providerOpenaiCompatExt } from "@dispatch/provider-openai-compat";
import { extension as sessionOrchestratorExt } from "@dispatch/session-orchestrator";
import { createSqliteStorage, extension as storageSqliteExt } from "@dispatch/storage-sqlite";
import { createLoadedExtensionsExtension } from "@dispatch/surface-loaded-extensions";
import { createSurfaceRegistryExtension } from "@dispatch/surface-registry";
import { extension as throughputStoreExt } from "@dispatch/throughput-store";
import { extension as toolEditFileExt } from "@dispatch/tool-edit-file";
import { extension as toolReadFileExt } from "@dispatch/tool-read-file";
import { extension as toolShellExt } from "@dispatch/tool-shell";
import { extension as toolWriteFileExt } from "@dispatch/tool-write-file";
import { createTransportHttpExtension } from "@dispatch/transport-http";
import { createTransportWsExtension } from "@dispatch/transport-ws";
import type { ChildHandle } from "./collector-supervisor.js";
import { createCollectorSupervisor } from "./collector-supervisor.js";
import { configMapToAccess, envToConfigMap } from "./config.js";
import { loadExternalExtensions } from "./load-external.js";

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

// Core extensions EXCEPT the credential-store, which is assembled in boot() so
// its credential list can include any credentials backed by external providers
// (e.g. a `claude` credential once the external Anthropic provider is loaded).
const CORE_EXTENSIONS: readonly Extension[] = [
	storageSqliteExt,
	conversationStoreExt,
	authApikeyExt,
	providerOpenaiCompatExt,
	toolEditFileExt,
	toolReadFileExt,
	toolShellExt,
	toolWriteFileExt,
	throughputStoreExt,
	sessionOrchestratorExt,
	createTransportHttpExtension(),
	// Surface extensions — dependency order: surface-registry first, then consumers.
	createSurfaceRegistryExtension(),
	createTransportWsExtension(),
	createLoadedExtensionsExtension(),
];

/** Parse the comma-separated list of external extension module specifiers. */
function parseExternalSpecifiers(env: Readonly<Record<string, string | undefined>>): string[] {
	return (env.DISPATCH_EXTERNAL_EXTENSIONS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function boot(): Promise<void> {
	const journalPath = process.env.DISPATCH_JOURNAL ?? "./.dispatch/journal/app.ndjson";
	mkdirSync(dirname(journalPath), { recursive: true });
	const logSink = createJournalSink({ path: journalPath });
	const logDeps: LogDeps = { now: () => Date.now(), newId: () => crypto.randomUUID() };
	const logger = createLogger({ extensionId: "host-bin" }, logSink, logDeps);

	const traceDbPath = process.env.DISPATCH_TRACE_DB ?? "./.dispatch-data/traces.db";

	const supervisor = createCollectorSupervisor({
		spawn: (cmd: string[]) => {
			const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
			const handle: ChildHandle = {
				kill: (signal?: string) => proc.kill(signal as NodeJS.Signals),
				exited: proc.exited,
			};
			return handle;
		},
		journalPath,
		dbPath: traceDbPath,
		logger: logger.child({ extensionId: "collector-supervisor" }),
	});
	supervisor.start();

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
		logSink,
		logDeps,
	};

	// Load external (out-of-repo) extensions declared via DISPATCH_EXTERNAL_EXTENSIONS.
	const externalSpecifiers = parseExternalSpecifiers(
		process.env as Readonly<Record<string, string | undefined>>,
	);
	const externalExtensions = await loadExternalExtensions(externalSpecifiers, logger);

	// Assemble the credential list. MVP keeps the hardcoded `opencode` credential
	// and adds a `claude` credential when an external Anthropic provider is loaded.
	const credentials = [{ name: "opencode", providerId: "openai-compat" }];
	const hasAnthropic = externalExtensions.some((e) =>
		e.manifest.contributes?.providers?.includes("anthropic"),
	);
	if (hasAnthropic) {
		const claudeName = process.env.DISPATCH_CLAUDE_CREDENTIAL ?? "claude";
		credentials.push({ name: claudeName, providerId: "anthropic" });
		logger.info(`Registered credential "${claudeName}" → anthropic provider`);
	}

	const extensions: Extension[] = [
		...CORE_EXTENSIONS,
		createCredentialStoreExtension({ credentials }),
		...externalExtensions,
	];

	const host = createHost(extensions, deps);
	await host.activate();

	const disabled = host.getDisabled();
	if (disabled.length > 0) {
		for (const d of disabled) {
			logger.warn(`Extension "${d.manifest.id}" disabled: ${d.reason}`);
		}
	}

	const shutdown = async () => {
		logger.info("Shutting down — draining collector");
		await supervisor.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	logger.info("Dispatch booted");
	console.info("Dispatch booted");
}

boot().catch((err) => {
	console.error("Fatal boot error:", err);
	process.exit(1);
});
