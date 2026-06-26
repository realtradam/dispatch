import { join, resolve } from "node:path";
import type { JsonSchemaProperty, ToolContract } from "@dispatch/kernel";
import type { ToolAssembly } from "@dispatch/session-orchestrator";
import { type SkillsDeps, scanSkillsDir } from "./load-skill.js";
import { mergeCatalog, renderDescription } from "./pure.js";

/**
 * Create a tools filter that rewrites the load_skill tool's description
 * and name parameter enum with the current skill catalog.
 */
export function makeSkillsToolFilter(deps: SkillsDeps) {
  const { homeDir, workdir } = deps;

  return async (asm: ToolAssembly): Promise<ToolAssembly> => {
    const effectiveBase = asm.cwd ? resolve(asm.cwd) : resolve(workdir);
    const cwdSkillsDir = join(effectiveBase, ".skills");
    const homeSkillsDir = join(resolve(homeDir), ".skills");

    let homeEntries: readonly import("./pure.js").SkillEntry[];
    let cwdEntries: readonly import("./pure.js").SkillEntry[];
    try {
      [homeEntries, cwdEntries] = await Promise.all([
        scanSkillsDir(homeSkillsDir),
        scanSkillsDir(cwdSkillsDir),
      ]);
    } catch {
      return asm;
    }

    const catalog = mergeCatalog(homeEntries, cwdEntries);
    const names = catalog.map((e) => e.name);
    const description = renderDescription(catalog);

    return {
      ...asm,
      tools: asm.tools.map((t: ToolContract) => {
        if (t.name !== "load_skill") return t;

        const nameProp = t.parameters.properties?.name;
        if (!nameProp) {
          return { ...t, description };
        }

        const updatedNameProp: JsonSchemaProperty =
          names.length > 0 ? { ...nameProp, enum: names } : { ...nameProp };

        const updatedProperties: Record<string, JsonSchemaProperty> = {
          ...t.parameters.properties,
          name: updatedNameProp,
        };

        return {
          ...t,
          description,
          parameters: {
            ...t.parameters,
            properties: updatedProperties,
          },
        };
      }),
    };
  };
}
