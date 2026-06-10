import { defineService } from "@dispatch/kernel";
import type { ThroughputStore } from "./store.js";

/** Typed service handle for the throughput store (record + aggregate). */
export const throughputStoreHandle = defineService<ThroughputStore>("throughput-store/store");
