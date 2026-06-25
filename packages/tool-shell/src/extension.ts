import { execBackendHandle } from "@dispatch/exec-backend";
import type { Extension } from "@dispatch/kernel";
import { createRunShellTool } from "./shell.js";

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
		// Host activates exec-backend first → host.getService at activation is safe.
		dependsOn: ["exec-backend"],
	},
	activate(host) {
		const resolveBackend = host.getService(execBackendHandle);
		host.defineTool(createRunShellTool({ workdir: process.cwd(), resolveBackend }));
	},
};
