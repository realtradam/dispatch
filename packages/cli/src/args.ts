/**
 * Pure argument parser — zero I/O, zero ambient state.
 *
 * Parses process.argv-style strings into a discriminated command union.
 * Validates required flags and reports unknown flags as errors.
 */

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const VALID_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function isValidEffort(value: string): value is ReasoningEffort {
  return (VALID_EFFORTS as readonly string[]).includes(value);
}

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
      readonly reasoningEffort?: ReasoningEffort | undefined;
      readonly showReasoning: boolean;
      readonly open: boolean;
      readonly workspaceId?: string | undefined;
    }
  | {
      readonly kind: "list";
      readonly server: string;
      readonly query?: string;
      readonly status?: string;
      readonly workspaceId?: string;
      readonly all: boolean;
    }
  | { readonly kind: "compact"; readonly server: string; readonly conversationId: string }
  | { readonly kind: "open"; readonly server: string; readonly conversationId: string }
  | { readonly kind: "read"; readonly server: string; readonly conversationId: string }
  | {
      readonly kind: "send";
      readonly server: string;
      readonly conversationId: string;
      readonly text?: string | undefined;
      readonly file?: string | undefined;
      readonly queue: boolean;
      readonly open: boolean;
      readonly cwd?: string;
      readonly reasoningEffort?: ReasoningEffort;
      readonly workspaceId?: string;
    }
  | { readonly kind: "stop"; readonly server: string; readonly conversationId: string }
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

  if (first === "list") {
    let server = opts.defaultServer;
    let query: string | undefined;
    let status: string | undefined;
    let workspaceId: string | undefined;
    let all = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--server") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
        server = argv[++i] as string;
      } else if (arg === "--status") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--status requires a value" };
        status = argv[++i];
      } else if (arg === "--workspace" || arg === "-w") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--workspace requires a value" };
        workspaceId = argv[++i];
      } else if (arg === "--all") {
        all = true;
      } else if (arg.startsWith("--")) {
        return { kind: "error", message: `Unknown flag: ${arg}` };
      } else if (query !== undefined) {
        return { kind: "error", message: `Unexpected argument for 'list': ${arg}` };
      } else {
        query = arg;
      }
    }
    return {
      kind: "list",
      server,
      ...(query !== undefined && { query }),
      ...(status !== undefined && { status }),
      ...(workspaceId !== undefined && { workspaceId }),
      all,
    };
  }

  if (first === "compact") {
    let server = opts.defaultServer;
    let conversationId: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--server") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
        server = argv[++i] as string;
      } else if (arg.startsWith("--")) {
        return { kind: "error", message: `Unknown flag: ${arg}` };
      } else if (conversationId !== undefined) {
        return { kind: "error", message: `Unexpected argument for 'compact': ${arg}` };
      } else {
        conversationId = arg;
      }
    }
    if (conversationId === undefined) {
      return { kind: "error", message: "'compact' requires a conversation id" };
    }
    return { kind: "compact", server, conversationId };
  }

  if (first === "stop") {
    let server = opts.defaultServer;
    let conversationId: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--server") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
        server = argv[++i] as string;
      } else if (arg.startsWith("--")) {
        return { kind: "error", message: `Unknown flag: ${arg}` };
      } else if (conversationId !== undefined) {
        return { kind: "error", message: `Unexpected argument for 'stop': ${arg}` };
      } else {
        conversationId = arg;
      }
    }
    if (conversationId === undefined) {
      return { kind: "error", message: "'stop' requires a conversation id" };
    }
    return { kind: "stop", server, conversationId };
  }

  if (first === "read") {
    let server = opts.defaultServer;
    let conversationId: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--server") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
        server = argv[++i] as string;
      } else if (arg.startsWith("--")) {
        return { kind: "error", message: `Unknown flag: ${arg}` };
      } else if (conversationId !== undefined) {
        return { kind: "error", message: `Unexpected argument for 'read': ${arg}` };
      } else {
        conversationId = arg;
      }
    }
    if (conversationId === undefined) {
      return { kind: "error", message: "'read' requires a conversation id" };
    }
    return { kind: "read", server, conversationId };
  }

  if (first === "open") {
    let server = opts.defaultServer;
    let conversationId: string | undefined;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      if (arg === "--server") {
        if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
        server = argv[++i] as string;
      } else if (arg.startsWith("--")) {
        return { kind: "error", message: `Unknown flag: ${arg}` };
      } else if (conversationId !== undefined) {
        return { kind: "error", message: `Unexpected argument for 'open': ${arg}` };
      } else {
        conversationId = arg;
      }
    }
    if (conversationId === undefined) {
      return { kind: "error", message: "'open' requires a conversation id" };
    }
    return { kind: "open", server, conversationId };
  }

  if (first === "send") {
    let server = opts.defaultServer;
    let conversationId: string | undefined;
    let text: string | undefined;
    let file: string | undefined;
    let queue = false;
    let open = false;
    let cwd: string | undefined;
    let reasoningEffort: ReasoningEffort | undefined;
    let workspaceId: string | undefined;

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i] as string;
      switch (arg) {
        case "--server":
          if (i + 1 >= argv.length) return { kind: "error", message: "--server requires a value" };
          server = argv[++i] as string;
          break;
        case "--text":
          if (i + 1 >= argv.length) return { kind: "error", message: "--text requires a value" };
          text = argv[++i];
          break;
        case "--file":
          if (i + 1 >= argv.length) return { kind: "error", message: "--file requires a value" };
          file = argv[++i];
          break;
        case "--queue":
          queue = true;
          break;
        case "--open":
          open = true;
          break;
        case "--cwd":
          if (i + 1 >= argv.length) return { kind: "error", message: "--cwd requires a value" };
          cwd = argv[++i];
          break;
        case "--effort": {
          if (i + 1 >= argv.length)
            return {
              kind: "error",
              message: `--effort requires a value (one of: ${VALID_EFFORTS.join(", ")})`,
            };
          const val = argv[++i] as string;
          if (!isValidEffort(val))
            return {
              kind: "error",
              message: `Invalid effort level "${val}". Must be one of: ${VALID_EFFORTS.join(", ")}`,
            };
          reasoningEffort = val;
          break;
        }
        case "--workspace":
        case "-w":
          if (i + 1 >= argv.length)
            return { kind: "error", message: "--workspace requires a value" };
          workspaceId = argv[++i];
          break;
        default:
          if (arg.startsWith("--")) return { kind: "error", message: `Unknown flag: ${arg}` };
          if (conversationId !== undefined)
            return { kind: "error", message: `Unexpected argument for 'send': ${arg}` };
          conversationId = arg;
      }
    }

    if (conversationId === undefined) {
      return { kind: "error", message: "'send' requires a conversation id" };
    }
    if (!text && !file) {
      return {
        kind: "error",
        message: "At least one of --text or --file is required for 'send'",
      };
    }

    return {
      kind: "send",
      server,
      conversationId,
      text,
      file,
      queue,
      open,
      ...(cwd !== undefined && { cwd }),
      ...(reasoningEffort !== undefined && { reasoningEffort }),
      ...(workspaceId !== undefined && { workspaceId }),
    };
  }

  // Chat mode: first arg is the model name
  const modelName = first;
  let text: string | undefined;
  let file: string | undefined;
  let cwd: string | undefined;
  let conversationId: string | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  let showReasoning = false;
  let open = false;
  let server = opts.defaultServer;
  let workspaceId: string | undefined;

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
      case "--open":
        open = true;
        break;
      case "--effort":
        if (i + 1 >= argv.length)
          return {
            kind: "error",
            message: `--effort requires a value (one of: ${VALID_EFFORTS.join(", ")})`,
          };
        {
          const val = argv[++i] as string;
          if (!isValidEffort(val))
            return {
              kind: "error",
              message: `Invalid effort level "${val}". Must be one of: ${VALID_EFFORTS.join(", ")}`,
            };
          reasoningEffort = val;
        }
        break;
      case "--workspace":
      case "-w":
        if (i + 1 >= argv.length) return { kind: "error", message: "--workspace requires a value" };
        workspaceId = argv[++i];
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
    reasoningEffort,
    showReasoning,
    open,
    ...(workspaceId !== undefined && { workspaceId }),
  };
}
