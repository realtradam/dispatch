import type { Extension, HostAPI, Manifest } from "@dispatch/kernel";

export const manifest: Manifest = {
	id: "storage-sqlite",
	name: "SQLite Storage Backend",
	version: "0.0.0",
	apiVersion: "^0.1.0",
	trust: "bundled",
	capabilities: { db: true },
	contributes: { services: ["storage"] },
	activation: "eager",
};

export const extension: Extension = {
	manifest,
	activate: async (_host: HostAPI) => {},
};
