/**
 * Extension model — manifest, extension lifecycle, and the Host API.
 *
 * An extension is a unit that contributes capabilities via the Host API.
 * The manifest declares what it provides and what it requires. The Host API
 * is the object an extension receives in `activate(host)` — it is the
 * §2.3 surface through which all registration and service access flows.
 */

import type { AuthContract } from "./auth.js";
import type {
  EventHandler,
  EventHookDescriptor,
  FilterDescriptor,
  FilterHandler,
  ServiceHandle,
} from "./hooks.js";
import type { Logger } from "./logging.js";

export type { Logger } from "./logging.js";

import type { ProviderContract } from "./provider.js";
import type { ToolContract } from "./tool.js";

// --- Manifest ---

/** Trust level of an extension, recorded for future policy differentiation. */
export type TrustLevel = "bundled" | "local" | "external";

/**
 * What an extension contributes to the system. Used by the host for
 * discovery, dependency resolution, and the capability gate.
 */
export interface ManifestContributions {
  readonly tools?: readonly string[];
  readonly providers?: readonly string[];
  readonly auth?: readonly string[];
  readonly hooks?: readonly string[];
  readonly routes?: readonly string[];
  readonly commands?: readonly string[];
  readonly services?: readonly string[];
  readonly migrations?: readonly string[];
  readonly scheduledJobs?: readonly string[];
  readonly settings?: readonly string[];
}

/**
 * Capabilities an extension declares it needs. The host uses these for the
 * capability gate — an extension can only access Host API surfaces it has
 * declared capability for.
 */
export interface ManifestCapabilities {
  readonly fs?: boolean;
  readonly shell?: boolean;
  readonly network?: boolean;
  readonly secrets?: boolean;
  readonly db?: boolean;
  readonly spawn?: boolean;
}

/**
 * An extension's declaration — what it is, what it provides, and what it
 * requires. The host uses this to resolve dependency DAG, check apiVersion
 * compatibility, and enforce the capability gate.
 */
export interface Manifest {
  /** Unique extension identifier (e.g. "tools-fs", "provider-anthropic"). */
  readonly id: string;

  /** Human-readable display name. */
  readonly name: string;

  /** Extension's own version (semver). */
  readonly version: string;

  /** Semver range of kernel API versions this extension is compatible with. */
  readonly apiVersion: string;

  /** Ids of extensions this one depends on (resolved topologically). */
  readonly dependsOn?: readonly string[];

  /** Activation strategy: "eager" (on boot) or lazy event triggers. */
  readonly activation?: "eager" | string;

  /** What this extension contributes to the system. */
  readonly contributes?: ManifestContributions;

  /** Capabilities this extension requires from the host. */
  readonly capabilities?: ManifestCapabilities;

  /** Trust level — bundled (first-party), local (project), or external. */
  readonly trust: TrustLevel;
}

// --- Storage interface ---

/**
 * Namespaced storage interface exposed through the Host API.
 * The concrete backend (SQLite) is a core extension; the kernel defines
 * only the contract. Supports key-value and simple query operations.
 */
export interface StorageNamespace {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
  readonly has: (key: string) => Promise<boolean>;
  readonly keys: (prefix?: string) => Promise<readonly string[]>;
}

// --- Permission ---

/** The outcome of a permission check. */
export interface PermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/** A request to check whether an action is permitted. */
export interface PermissionRequest {
  readonly tool: string;
  readonly action: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

/** Permission gate exposed through the Host API. */
export interface PermissionGate {
  readonly check: (request: PermissionRequest) => Promise<PermissionDecision>;
}

// --- Scheduler ---

/** A scheduled job definition an extension can register with the host. */
export interface ScheduledJob {
  readonly id: string;
  readonly cron: string;
  readonly execute: () => void | Promise<void>;
}

// --- Logger is re-exported from logging.ts (structured, correlated) ---

// --- Config ---

/** Read-only config access for an extension's own settings namespace. */
export interface ConfigAccess {
  readonly get: <T = unknown>(key: string) => T | undefined;
  readonly getAll: () => Readonly<Record<string, unknown>>;
}

// --- Secrets ---

/** Capability-gated access to the secret/credential vault. */
export interface SecretsAccess {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

// --- Events emitter ---

/** Outward event emitter available to extensions via the Host API. */
export interface EventsEmitter {
  readonly emit: (event: { readonly type: string; readonly [key: string]: unknown }) => void;
}

// --- Host API ---

/**
 * The Host API — what every extension receives in `activate(host)`.
 *
 * This is the §2.3 surface: the single object through which an extension
 * registers tools, providers, auth, hooks, services, and accesses kernel
 * services (storage, config, secrets, permissions, logging, scheduling).
 *
 * Method signatures are typed contracts; implementations live in the host
 * module (not the kernel contracts).
 */
export interface HostAPI {
  /** Register a tool with the kernel's tool registry. */
  readonly defineTool: (tool: ToolContract) => void;

  /** Register a provider with the kernel's provider registry. */
  readonly defineProvider: (provider: ProviderContract) => void;

  /** Register an auth provider with the kernel's auth registry. */
  readonly defineAuth: (auth: AuthContract) => void;

  /** Subscribe to an event hook. Handlers are error-isolated per call. */
  readonly on: <TPayload>(
    hook: EventHookDescriptor<TPayload>,
    handler: EventHandler<TPayload>,
  ) => () => void;

  /**
   * Emit an event hook: fire-and-forget dispatch to every `on` subscriber,
   * error-isolated per handler (a thrown handler is caught + logged, never
   * breaks the caller). The counterpart of `on`.
   *
   * This lets a core extension that OWNS a lifecycle publish typed events that
   * standard extensions react to — e.g. the session-orchestrator emitting
   * per-turn start/settle events a cache-warming extension subscribes to. The
   * kernel owns the mechanism; the owner declares the typed `EventHookDescriptor`.
   */
  readonly emit: <TPayload>(hook: EventHookDescriptor<TPayload>, payload: TPayload) => void;

  /** Add a filter to a filter hook chain. Filters are awaited in-band. */
  readonly addFilter: <TValue>(
    hook: FilterDescriptor<TValue>,
    fn: FilterHandler<TValue>,
  ) => () => void;

  /**
   * Run a filter chain: thread `value` through every filter registered for
   * `hook` in priority/registration order and return the final value. The
   * single-value-in/value-out counterpart to `addFilter`. Awaited in-band.
   *
   * Fail-open by default (a thrown filter is logged and the value passes
   * through unchanged); pass `{ failClosed: true }` to make a thrown filter
   * reject. With no registered filters the input value is returned as-is.
   *
   * This is what lets a core extension expose a contribution point (e.g. the
   * session-orchestrator running a per-turn tool/context-assembly chain) that
   * standard extensions plug into via `addFilter` — the kernel owns the
   * mechanism, the owner declares the typed `FilterDescriptor`.
   */
  readonly applyFilters: <TValue>(
    hook: FilterDescriptor<TValue>,
    value: TValue,
    opts?: { readonly failClosed?: boolean },
  ) => Promise<TValue>;

  /** Provide an implementation for a typed service handle. */
  readonly provideService: <T>(handle: ServiceHandle<T>, impl: T) => void;

  /** Retrieve the implementation for a typed service handle. */
  readonly getService: <T>(handle: ServiceHandle<T>) => T;

  /** Get a namespaced storage interface for this extension. */
  readonly storage: (namespace: string) => StorageNamespace;

  /** Read-only access to merged config (global → project → extension). */
  readonly config: ConfigAccess;

  /** Capability-gated access to the secret/credential vault. */
  readonly secrets: SecretsAccess;

  /** Permission gate — check whether an action is allowed. */
  readonly permissions: PermissionGate;

  /** Emit outward events (transport pushes these to clients). */
  readonly events: EventsEmitter;

  /** Logger — always available, even before other extensions activate. */
  readonly logger: Logger;

  /** Read-only view of all registered providers. */
  readonly getProviders: () => ReadonlyMap<string, ProviderContract>;

  /** Read-only view of all registered tools. */
  readonly getTools: () => ReadonlyMap<string, ToolContract>;

  /** Read-only view of all registered auth providers. */
  readonly getAuthProviders: () => ReadonlyMap<string, AuthContract>;

  /** Look up a single auth provider by id. */
  readonly getAuthProvider: (id: string) => AuthContract | undefined;

  /** Read-only view of all activated extensions' manifests (what is loaded). */
  readonly getExtensions: () => readonly Manifest[];

  /** Register a scheduled job with the host's scheduler. */
  readonly scheduler: {
    readonly register: (job: ScheduledJob) => void;
  };
}

// --- Extension lifecycle ---

/**
 * An extension — the unit that contributes capabilities to Dispatch.
 * `activate` is called by the host during boot (or lazy activation);
 * `deactivate` is optional and called on shutdown or reload.
 */
export interface Extension {
  /** The extension's manifest — its declaration of identity and capabilities. */
  readonly manifest: Manifest;

  /**
   * Called by the host to activate the extension. The extension registers
   * its contributions (tools, providers, hooks, services) through the Host API.
   */
  readonly activate: (host: HostAPI) => void | Promise<void>;

  /**
   * Optional cleanup called when the extension is deactivated (shutdown,
   * reload, or auto-disable). Should dispose resources the extension owns.
   */
  readonly deactivate?: () => void | Promise<void>;
}
