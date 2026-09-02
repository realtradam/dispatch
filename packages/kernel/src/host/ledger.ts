/**
 * Per-extension registration ledger — the single source of truth for "what
 * does plugin X own".
 *
 * The host wraps every per-extension HostAPI registration method so that it
 * records what it registered here before delegating. The ledger is what makes
 * unload verifiable and force-cleanup possible: after `deactivate()` the host
 * checks every tracked registration and force-cleans + logs anything left.
 *
 * Pure bookkeeping: map/array mutation only, no I/O, no clocks. Disposal
 * tracking is observational — the ledger wraps the disposer it is given and
 * hands the WRAPPED disposer back to the extension, so it can see whether the
 * extension actually called it. Calling a wrapped disposer twice is a no-op
 * (idempotent), mirroring the bus disposers it wraps.
 */

/** Kinds of registration that have an extension-side disposal path. */
export type DisposalKind = "service" | "subscription" | "filter";

/**
 * A registration that survived `deactivate()` and was force-cleaned by the
 * host (disposal contract, §9). Reported in `UnloadResult.dangling` and
 * logged as "dangling registration from plugin X".
 */
export interface DanglingRegistration {
  readonly kind: DisposalKind | "job";
  /** Handle id (service), hook id (subscription/filter), or job id. */
  readonly id: string;
}

/**
 * A tracked registration that the extension is required to dispose itself.
 * `dispose` is the ledger-wrapped disposer (the exact function the extension
 * received from the HostAPI); calling it marks the registration disposed.
 */
export interface TrackedDisposal {
  readonly kind: DisposalKind;
  /** Handle id (service) or hook id (subscription/filter). */
  readonly id: string;
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

/** Everything one extension registered, grouped by kind. */
export interface LedgerEntry {
  readonly extensionId: string;
  /** Tool names registered via `defineTool`. */
  readonly tools: string[];
  /** Provider ids registered via `defineProvider`. */
  readonly providers: string[];
  /** Auth ids registered via `defineAuth`. */
  readonly auth: string[];
  /** Scheduled job ids registered via `scheduler.register`. */
  readonly jobs: string[];
  /** Registrations with an extension-side disposal path. */
  readonly disposals: TrackedDisposal[];
}

export class ExtensionLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  private entryFor(extensionId: string): LedgerEntry {
    let entry = this.entries.get(extensionId);
    if (entry === undefined) {
      entry = {
        extensionId,
        tools: [],
        providers: [],
        auth: [],
        jobs: [],
        disposals: [],
      };
      this.entries.set(extensionId, entry);
    }
    return entry;
  }

  trackTool(extensionId: string, name: string): void {
    this.entryFor(extensionId).tools.push(name);
  }

  trackProvider(extensionId: string, id: string): void {
    this.entryFor(extensionId).providers.push(id);
  }

  trackAuth(extensionId: string, id: string): void {
    this.entryFor(extensionId).auth.push(id);
  }

  trackJob(extensionId: string, jobId: string): void {
    this.entryFor(extensionId).jobs.push(jobId);
  }

  /** Forget a job registration (the extension unregistered it). */
  untrackJob(extensionId: string, jobId: string): void {
    const entry = this.entries.get(extensionId);
    if (entry === undefined) return;
    const idx = entry.jobs.indexOf(jobId);
    if (idx !== -1) entry.jobs.splice(idx, 1);
  }

  /**
   * Track a registration that must be disposed by the extension. Returns the
   * wrapped disposer — the HostAPI hands this (not the raw one) to the
   * extension, so calling it is observed here. Idempotent: a second call is
   * a no-op.
   */
  trackDisposal(extensionId: string, kind: DisposalKind, id: string, raw: () => void): () => void {
    let disposed = false;
    const wrapped: TrackedDisposal = {
      kind,
      id,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        raw();
      },
      isDisposed: () => disposed,
    };
    this.entryFor(extensionId).disposals.push(wrapped);
    return wrapped.dispose;
  }

  getEntry(extensionId: string): LedgerEntry | undefined {
    return this.entries.get(extensionId);
  }

  has(extensionId: string): boolean {
    return this.entries.has(extensionId);
  }

  /** Drop the extension's entry entirely (after the host has swept it). */
  remove(extensionId: string): void {
    this.entries.delete(extensionId);
  }
}
