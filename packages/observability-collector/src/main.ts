import { createTraceStore } from "@dispatch/trace-store";
import { drainOnce, readOffset, writeOffset } from "./collector.js";

// --- Argv parsing ---

interface CliArgs {
	readonly journal: string;
	readonly db: string;
	readonly interval: number;
}

function parseArgs(argv: string[]): CliArgs {
	let journal = "";
	let db = "./.dispatch-data/traces.db";
	let interval = 250;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--journal" && i + 1 < argv.length) {
			journal = argv[i + 1] ?? "";
			i++;
		} else if (arg === "--db" && i + 1 < argv.length) {
			db = argv[i + 1] ?? db;
			i++;
		} else if (arg === "--interval" && i + 1 < argv.length) {
			const val = Number(argv[i + 1]);
			if (Number.isFinite(val) && val > 0) interval = val;
			i++;
		}
	}

	if (!journal) {
		console.error(
			"Usage: observability-collector --journal <path> [--db <path>] [--interval <ms>]",
		);
		process.exit(1);
	}

	return { journal, db, interval };
}

// --- Main loop ---

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const sidecarPath = `${args.journal}.collector-offset`;
	const store = createTraceStore({ path: args.db });

	let offset = readOffset(sidecarPath);

	let shuttingDown = false;

	function onSignal(): void {
		if (shuttingDown) return;
		shuttingDown = true;
	}

	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	while (!shuttingDown) {
		const result = drainOnce({ journalPath: args.journal, offset, store });
		if (result.newOffset !== offset) {
			offset = result.newOffset;
			writeOffset(sidecarPath, offset);
		}
		await sleep(args.interval);
	}

	// Final drain on shutdown
	const finalResult = drainOnce({ journalPath: args.journal, offset, store });
	if (finalResult.newOffset !== offset) {
		writeOffset(sidecarPath, finalResult.newOffset);
	}

	store.close();
	process.exit(0);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
	console.error("[observability-collector] fatal:", err);
	process.exit(1);
});
