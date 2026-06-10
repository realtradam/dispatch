import type { Extension } from "@dispatch/kernel";
import { createRunShellTool } from "./shell.js";
import { realSpawn } from "./spawn.js";

export const extension: Extension = {
	manifest: {
		id: "tool-shell",
		name: "Shell Tool",
		version: "0.0.0",
		apiVersion: "^0.1.0",
		trust: "bundled",
		activation: "eager",
		capabilities: { shell: true },
		contributes: { tools: ["run_shell"] },
	},
	activate(host) {
		host.defineTool(createRunShellTool({ workdir: process.cwd(), spawn: realSpawn }));
	},
};
