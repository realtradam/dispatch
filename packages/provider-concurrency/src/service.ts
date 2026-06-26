import { defineService } from "@dispatch/kernel";
import type { ConcurrencyService } from "./concurrency-manager.js";

/**
 * Typed service handle for the provider-concurrency service. The
 * `provider-concurrency` extension provides the implementation; the
 * session-orchestrator + transport-http consume it.
 */
export const concurrencyServiceHandle = defineService<ConcurrencyService>(
  "provider-concurrency/service",
);
