#!/usr/bin/env bun
/**
 * Import Claude credentials into the Dispatch SQLite database.
 * Reads from ~/.claude/.credentials-{1,2}.json and stores them
 * for the configured keys (claude-pro, claude-max).
 */
import { getDatabasePath, importCredentialsFromFile } from "../packages/core/src/index.js";

const imports = [
	{
		keyId: "claude-pro",
		provider: "anthropic",
		file: `${process.env.HOME}/.claude/.credentials-1.json`,
	},
	{
		keyId: "claude-max",
		provider: "anthropic",
		file: `${process.env.HOME}/.claude/.credentials-2.json`,
	},
];

console.log(`Database: ${getDatabasePath()}\n`);

for (const { keyId, provider, file } of imports) {
	process.stdout.write(`Importing ${keyId} from ${file} ... `);
	const result = importCredentialsFromFile(keyId, provider, file);
	if (result.success) {
		console.log("OK");
	} else {
		console.log(`FAILED: ${result.error}`);
	}
}

console.log("\nDone.");
