import type { Extension } from "@dispatch/kernel";
import { createReadFileTool } from "./read-file.js";

export const extension: Extension = {
	manifest: {
		id: "tool-read-file",
		name: "Read File Tool",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { fs: true },
		contributes: { tools: ["read_file"] },
	},
	activate(host) {
		host.defineTool(createReadFileTool(process.cwd()));
	},
};
