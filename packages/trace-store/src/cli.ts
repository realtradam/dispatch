import { createTraceStore } from "./store.js";

const turnId = process.argv[2];
if (turnId === undefined) {
	console.error("Usage: bun packages/trace-store/src/cli.ts <turnId> [dbPath]");
	process.exit(1);
}

const dbPath = process.argv[3] ?? process.env.TRACE_DB_PATH ?? "./.dispatch-data/traces.db";
const store = createTraceStore({ path: dbPath });
try {
	const output = store.easyView(turnId);
	console.log(output);
} finally {
	store.close();
}
