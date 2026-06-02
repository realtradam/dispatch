import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentDefinition } from "@dispatch/core";
import {
	deleteAgent,
	getAgentDirs,
	isReasoningEffort,
	loadAgents,
	saveAgent,
} from "@dispatch/core";
import { Hono } from "hono";

const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]+$/;

function isValidSlug(slug: string): boolean {
	return SAFE_SLUG_RE.test(slug) && slug.length > 0 && slug.length <= 100;
}

const agentsRoutes = new Hono();

// GET /agents — list all agents (global + project-scoped)
// Query param: ?projectDir=... (optional, the working directory)
agentsRoutes.get("/", (c) => {
	const projectDir = c.req.query("projectDir") || process.env.DISPATCH_WORKING_DIR || undefined;
	const agents = loadAgents(projectDir);
	const dirs = getAgentDirs(projectDir);
	return c.json({ agents, dirs });
});

// GET /agents/dirs — list available agent directories
agentsRoutes.get("/dirs", (c) => {
	const projectDir = c.req.query("projectDir") || process.env.DISPATCH_WORKING_DIR || undefined;
	const dirs = getAgentDirs(projectDir);
	return c.json({ dirs });
});

// POST /agents — create or update an agent
agentsRoutes.post("/", async (c) => {
	try {
		const body = await c.req.json<AgentDefinition>();
		// Validate required fields
		if (!body.name || !body.slug || !body.scope) {
			return c.json({ error: "name, slug, and scope are required" }, 400);
		}
		if (!isValidSlug(body.slug)) {
			return c.json(
				{ error: "Invalid slug: must be alphanumeric with hyphens/underscores only" },
				400,
			);
		}
		if (body.scope !== "global" && body.scope.includes("..")) {
			return c.json({ error: "Invalid scope" }, 400);
		}
		// Ensure arrays exist
		const agent: AgentDefinition = {
			name: body.name,
			description: body.description || "",
			skills: body.skills || [],
			tools: body.tools || [],
			models: (body.models || []).map((m) => ({
				key_id: m.key_id,
				model_id: m.model_id,
				// Keep `effort` only when it's a recognised level; drop anything else.
				...(isReasoningEffort(m.effort) ? { effort: m.effort } : {}),
			})),
			scope: body.scope,
			slug: body.slug,
			...(body.cwd ? { cwd: body.cwd } : {}),
			...(body.is_subagent ? { is_subagent: true } : {}),
		};
		saveAgent(agent);
		return c.json({ ok: true, agent });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : "Failed to save agent" }, 500);
	}
});

// DELETE /agents/:slug — delete an agent
// Query param: ?scope=... (required: "global" or directory path)
agentsRoutes.delete("/:slug", (c) => {
	const slug = c.req.param("slug");
	const scope = c.req.query("scope");
	if (!scope) {
		return c.json({ error: "scope query param is required" }, 400);
	}
	if (!isValidSlug(slug)) {
		return c.json({ error: "Invalid slug" }, 400);
	}
	if (slug === "default" && scope === "global") {
		return c.json({ error: "Cannot delete the default agent" }, 403);
	}
	if (scope !== "global" && scope.includes("..")) {
		return c.json({ error: "Invalid scope" }, 400);
	}
	const deleted = deleteAgent(slug, scope);
	if (!deleted) {
		return c.json({ error: "Agent not found" }, 404);
	}
	return c.json({ ok: true });
});

// GET /agents/check-dir?path=... — check if a directory exists
agentsRoutes.get("/check-dir", (c) => {
	let dirPath = c.req.query("path");
	if (!dirPath) {
		return c.json({ exists: false });
	}
	// Expand ~ to home directory
	if (dirPath === "~" || dirPath.startsWith("~/")) {
		dirPath = path.join(os.homedir(), dirPath.slice(1));
	}
	// Resolve relative paths against the project root
	if (!path.isAbsolute(dirPath)) {
		const projectDir = process.env.DISPATCH_WORKING_DIR || process.cwd();
		dirPath = path.resolve(projectDir, dirPath);
	}
	try {
		const stat = fs.statSync(dirPath);
		return c.json({ exists: stat.isDirectory(), resolved: dirPath });
	} catch {
		return c.json({ exists: false, resolved: dirPath });
	}
});

export { agentsRoutes };
