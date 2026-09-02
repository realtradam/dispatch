export type { DagResolution, ResolveActivationOrderSafeOpts } from "./dag.js";
export { resolveActivationOrder, resolveActivationOrderSafe } from "./dag.js";
export type {
  DisabledExtension,
  Host,
  HostDeps,
  LifecycleOperationOpts,
  LoadResult,
  ReloadResult,
  UnloadResult,
} from "./host.js";
export { createHost, KERNEL_API_VERSION } from "./host.js";
export type {
  DanglingRegistration,
  DisposalKind,
  LedgerEntry,
  TrackedDisposal,
} from "./ledger.js";
export { ExtensionLedger } from "./ledger.js";
export { isApiVersionCompatible } from "./version.js";
