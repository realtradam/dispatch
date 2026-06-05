/**
 * Pure argument parser — zero I/O, zero ambient state.
 *
 * Parses process.argv-style strings into a discriminated command union.
 * Validates required flags and reports unknown flags as errors.
 */

export type ParsedCommand =
	| { readonly kind: "models"; readonly server: string }
	| {
			readonly kind: "chat";
			readonly server: string;
			readonly modelName: string;
			readonly text?: string | undefined;
			readonly file?: string | undefined;
			readonly cwd?: string | undefined;
			readonly conversationId?: string | undefined;
			readonly showReasoning: boolean;
	  }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string };

interface ParseOpts {
	readonly defaultServer: string;
}

export function parseArgs(argv: readonly string[], opts: ParseOpts): ParsedCommand {
	if (argv.length === 0) {
		return { kind: "help" };
	}

	const first = argv[0] as string;

	if (first === "--help" || first === "-h") {
		return { kind: "help" };
	}

	if (first === "models") {
		let server = opts.defaultServer;
		for (let i = 1; i < argv.length; i++) {
			if (argv[i] === "--server" && i + 1 < argv.length) {
				server = argv[++i] as string;
			} else {
				return { kind: "error", message: `Unknown argument for 'models': ${argv[i]}` };
			}
		}
		return { kind: "models", server };
	}

	// Chat mode: first arg is the model name
	const modelName = first;
	let text: string | undefined;
	let file: string | undefined;
	let cwd: string | undefined;
	let conversationId: string | undefined;
	let showReasoning = false;
	let server = opts.defaultServer;

	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] as string;
		switch (arg) {
			case "--text":
				if (i + 1 >= argv.length) return { kind: "error", message: "--text requires a value" };
				text = argv[++i];
				break;
			case "--file":
				if (i + 1 >= argv.length) return { kind: "error", message: "--file requires a value" };
				file = argv[++i];
				break;
			case "--cwd":
				if (i + 1 >= argv.length) return { kind: "error", message: "--cwd requires a value" };
				cwd = argv[++i];
				break;
			case "--conversation":
				if (i + 1 >= argv.length)
					return { kind: "error", message: "--conversation requires a value" };
				conversationId = argv[++i];
				break;
			case "--server":
				if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
				server = argv[++i] as string;
				break;
			case "--show-reasoning":
				showReasoning = true;
				break;
			default:
				return { kind: "error", message: `Unknown flag: ${arg}` };
		}
	}

	if (!text && !file) {
		return {
			kind: "error",
			message: "At least one of --text or --file is required for a chat command",
		};
	}

	return {
		kind: "chat",
		server,
		modelName,
		text,
		file,
		cwd,
		conversationId,
		showReasoning,
	};
}
