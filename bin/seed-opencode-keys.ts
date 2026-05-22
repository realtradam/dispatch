#!/usr/bin/env bun
/**
 * Seed API keys from environment variables into the SQLite database.
 */
import { getDatabasePath, setApiKey } from "../packages/core/src/index.js";

console.log(`Database: ${getDatabasePath()}\n`);

const keys = [
	{ keyId: "opencode-1", provider: "opencode-go", envVar: "OPENCODE_KEY_1" },
	{ keyId: "opencode-2", provider: "opencode-go", envVar: "OPENCODE_KEY_2" },
	{ keyId: "copilot", provider: "github-copilot", envVar: "COPILOT_TOKEN" },
	{ keyId: "opencode-cookie", provider: "opencode-go", envVar: "OPENCODE_COOKIE" },
	{ keyId: "opencode-ws1", provider: "opencode-go", envVar: "OPENCODE_WS1_ID" },
	{ keyId: "opencode-ws2", provider: "opencode-go", envVar: "OPENCODE_WS2_ID" },
];

for (const { keyId, provider, envVar } of keys) {
	const value = process.env[envVar];
	if (value) {
		setApiKey(keyId, provider, value);
		console.log(`${keyId}: imported from $${envVar}`);
	} else {
		console.log(`${keyId}: SKIPPED ($${envVar} not set)`);
	}
}

console.log("\nDone.");
