import type { PermissionRule, Ruleset } from "./index.js";
import { Wildcard } from "./wildcard.js";

export function evaluate(
	permission: string,
	pattern: string,
	...rulesets: Ruleset[]
): PermissionRule {
	const flat = ([] as PermissionRule[]).concat(...rulesets);
	const match = flat.findLast(
		(rule) => Wildcard.match(rule.permission, permission) && Wildcard.match(rule.pattern, pattern),
	);
	if (match) return match;
	return { action: "ask", permission, pattern };
}
