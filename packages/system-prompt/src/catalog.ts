/**
 * Static catalog of available system-prompt variables.
 *
 * Returned by `GET /system-prompt/variables` so the frontend can render the
 * variable selector buttons. The `file:` type is marked `dynamic: true` — any
 * name (file path) is valid for it.
 */
import type { SystemPromptVariable } from "@dispatch/transport-contract";

export function getVariableCatalog(): SystemPromptVariable[] {
	return [
		{ type: "system", name: "time", description: "Current time in ISO 8601 format" },
		{ type: "system", name: "date", description: "Current date (YYYY-MM-DD)" },
		{ type: "system", name: "os", description: "Operating system platform" },
		{ type: "system", name: "hostname", description: "Machine hostname" },
		{ type: "prompt", name: "cwd", description: "Conversation working directory" },
		{ type: "prompt", name: "model", description: "Current model name" },
		{ type: "prompt", name: "conversation_id", description: "Conversation identifier" },
		{ type: "git", name: "branch", description: "Current git branch" },
		{ type: "git", name: "status", description: "Short git status" },
		{
			type: "file",
			name: "<path>",
			description: "Contents of a file (relative to cwd, or absolute if it starts with /)",
			dynamic: true,
		},
	];
}
