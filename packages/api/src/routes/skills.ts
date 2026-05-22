import type { AgentSkillMapping, SkillDefinition, SkillScope } from "@dispatch/core";
import { Hono } from "hono";

let getSkills: () => { skills: SkillDefinition[]; mappings: AgentSkillMapping[] } = () => ({
	skills: [],
	mappings: [],
});

export function setSkillsGetter(
	getter: () => { skills: SkillDefinition[]; mappings: AgentSkillMapping[] },
): void {
	getSkills = getter;
}

export const skillsRoutes = new Hono();

skillsRoutes.get("/", (c) => {
	const { skills, mappings } = getSkills();
	const skillSummaries = skills.map(({ name, description, tags, scope, directory }) => ({
		name,
		description,
		tags,
		scope,
		directory,
	}));
	return c.json({ skills: skillSummaries, mappings });
});

skillsRoutes.get("/:name", (c) => {
	const { name } = c.req.param();
	const scopeParam = c.req.query("scope") as SkillScope | undefined;
	const { skills } = getSkills();

	const matches = skills.filter((s) => s.name === name);
	if (matches.length === 0) {
		return c.json({ error: "Skill not found" }, 404);
	}

	if (scopeParam) {
		const scoped = matches.find((s) => s.scope === scopeParam);
		if (!scoped) {
			return c.json({ error: "Skill not found" }, 404);
		}
		return c.json(scoped);
	}

	return c.json(matches[0]);
});
