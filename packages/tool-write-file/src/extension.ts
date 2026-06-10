import type { Extension } from "@dispatch/kernel";
import { createWriteFileTool } from "./write-file.js";

export const extension: Extension = {
	manifest: {
		id: "tool-write-file",
		name: "Write File Tool",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { fs: true },
		contributes: { tools: ["write_file"] },
	},
	activate(host) {
		host.defineTool(createWriteFileTool(process.cwd()));
	},
};
