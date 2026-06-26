import { homedir } from "node:os";
import type { Extension, HostAPI } from "@dispatch/kernel";
import { toolsFilter } from "@dispatch/session-orchestrator";
import { createLoadSkillTool } from "./load-skill.js";
import { makeSkillsToolFilter } from "./tools-filter.js";

export const extension: Extension = {
  manifest: {
    id: "skills",
    name: "Skills",
    version: "0.0.0",
    apiVersion: "^0.1.0",
    trust: "bundled",
    activation: "eager",
    dependsOn: ["session-orchestrator"],
    capabilities: { fs: true },
    contributes: { tools: ["load_skill"] },
  },
  activate(host: HostAPI) {
    const homeDir = homedir();
    const workdir = process.cwd();

    host.defineTool(createLoadSkillTool({ homeDir, workdir }));
    host.addFilter(toolsFilter, makeSkillsToolFilter({ homeDir, workdir }));
  },
};
