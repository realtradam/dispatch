export interface PermissionRule {
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
}

export type Ruleset = PermissionRule[];

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionRequest {
	permission: string;
	patterns: string[];
	always: string[];
	description: string;
	metadata: Record<string, unknown>;
}

export interface PermissionChecker {
	ask(request: PermissionRequest, rulesets: Ruleset[]): Promise<PermissionReply>;
	getPending(): Array<{ id: string; request: PermissionRequest }>;
}

export { evaluate } from "./evaluate.js";
export { PermissionService } from "./service.js";
export { Wildcard } from "./wildcard.js";
