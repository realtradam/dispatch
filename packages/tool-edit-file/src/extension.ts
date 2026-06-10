import type { Extension } from "@dispatch/kernel";
import { createEditFileTool } from "./edit-file.js";

export const extension: Extension = {
	manifest: {
		id: "tool-edit-file",
		name: "Edit File Tool",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { fs: true },
		contributes: { tools: ["edit_file"] },
	},
	activate(host) {
		host.defineTool(createEditFileTool(process.cwd()));
	},
};
