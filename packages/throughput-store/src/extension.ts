import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";
import { throughputStoreHandle } from "./service.js";
import { createThroughputStore } from "./store.js";

export const manifest: Manifest = {
  id: "throughput-store",
  name: "Throughput Store",
  version: "0.0.0",
  apiVersion: "^0.1.0",
  trust: "bundled",
  capabilities: { db: true },
  contributes: { services: ["throughput-store/store"] },
  activation: "eager",
};

export const extension: Extension = {
  manifest,
  activate: (host: HostAPI) => {
    const storage = host.storage("throughput-store");
    const store = createThroughputStore({ storage, logger: host.logger });
    host.provideService(throughputStoreHandle, store);
    host.logger.info("throughput-store: registered");
  },
};
