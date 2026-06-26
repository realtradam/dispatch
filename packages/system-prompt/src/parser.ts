/**
 * Pure template parser — input → output, zero I/O.
 *
 * Handles variable insertion (`[type:name]`) and conditional blocks
 * (`[if]`/`[else]`/`[endif]`, including negated `[if !...]` and nesting).
 * Unmatched control tags are emitted as literal text (the tag passes through
 * unchanged; surrounding content is parsed normally).
 *
 * Variable resolution rules (driven by the `vars` map):
 * - value is a string → insert it
 * - value is `null` (not existing) → insert empty string
 * - key absent from the map (unknown type) → insert empty string
 *
 * Conditional existence: a variable "exists" iff it is present in the map AND
 * its value is a string (not `null`). A `null` value or an absent key both mean
 * "does not exist".
 */

// ─── Token model ─────────────────────────────────────────────────────────────

interface TextToken {
  readonly kind: "text";
  readonly value: string;
}
interface VarToken {
  readonly kind: "var";
  readonly key: string;
  readonly raw: string;
}
interface IfToken {
  readonly kind: "if";
  readonly key: string;
  readonly negated: boolean;
  readonly raw: string;
}
interface ElseToken {
  readonly kind: "else";
  readonly raw: string;
}
interface EndifToken {
  readonly kind: "endif";
  readonly raw: string;
}
type Token = TextToken | VarToken | IfToken | ElseToken | EndifToken;

// ─── Node model (AST) ────────────────────────────────────────────────────────

interface TextNode {
  readonly kind: "text";
  readonly value: string;
}
interface VarNode {
  readonly kind: "var";
  readonly key: string;
}
interface IfNode {
  kind: "if";
  key: string;
  negated: boolean;
  thenBranch: Node[];
  else: Node[] | null;
  matched: boolean;
  readonly raw: string;
}
type Node = TextNode | VarNode | IfNode;

// ─── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * Classify the content between `[` and `]` into a control/variable token, or
 * `null` when it is not a recognized tag (then it stays literal text).
 */
function classifyTag(content: string): Token | null {
  const trimmed = content.trim();
  if (trimmed === "endif") return { kind: "endif", raw: `[${content}]` };
  if (trimmed === "else") return { kind: "else", raw: `[${content}]` };

  // `[if type:name]` / `[if !type:name]`
  const ifMatch = /^if\s+(!?)(\w+:.*)$/.exec(trimmed);
  if (ifMatch) {
    const negated = (ifMatch[1] ?? "") === "!";
    const key = ifMatch[2] ?? "";
    return { kind: "if", key, negated, raw: `[${content}]` };
  }

  // `[type:name]` — variable insertion (any `word:rest`)
  const varMatch = /^(\w+:.*)$/.exec(trimmed);
  if (varMatch) return { kind: "var", key: trimmed, raw: `[${content}]` };

  return null;
}

/**
 * Split a template into a flat token stream: text, variable, and control tags.
 * A `[` with no closing `]`, or whose content is not a recognized tag, is kept
 * as literal text.
 */
function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let i = 0;
  const n = template.length;

  const flush = (): void => {
    if (buf.length > 0) {
      tokens.push({ kind: "text", value: buf });
      buf = "";
    }
  };

  while (i < n) {
    const ch = template[i];
    if (ch === undefined) break;
    if (ch === "[") {
      const close = template.indexOf("]", i + 1);
      if (close === -1) {
        buf += "[";
        i++;
        continue;
      }
      const content = template.slice(i + 1, close);
      const tag = classifyTag(content);
      if (tag !== null) {
        flush();
        tokens.push(tag);
        i = close + 1;
        continue;
      }
      buf += "[";
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return tokens;
}

// ─── Parser (token stream → AST) ─────────────────────────────────────────────

const EMPTY: readonly Node[] = Object.freeze([]) as readonly Node[];

/**
 * Build an AST from tokens using an explicit stack. `if`/`else`/`endif` are
 * matched here: an `if` left open at end-of-input is marked unmatched, and a
 * stray `else`/`endif` (no open `if`) becomes a literal text node.
 */
function parse(tokens: readonly Token[]): Node[] {
  const root: Node[] = [];
  const stack: IfNode[] = [];
  let current: Node[] = root;

  for (const tok of tokens) {
    switch (tok.kind) {
      case "text":
        current.push({ kind: "text", value: tok.value });
        break;
      case "var":
        current.push({ kind: "var", key: tok.key });
        break;
      case "if": {
        const node: IfNode = {
          kind: "if",
          key: tok.key,
          negated: tok.negated,
          thenBranch: [],
          else: null,
          matched: true,
          raw: tok.raw,
        };
        current.push(node);
        stack.push(node);
        current = node.thenBranch;
        break;
      }
      case "else": {
        const top = stack[stack.length - 1];
        if (top !== undefined && top.else === null) {
          top.else = [];
          current = top.else;
        } else {
          // stray else (no open if, or if already has an else) → literal
          current.push({ kind: "text", value: tok.raw });
        }
        break;
      }
      case "endif": {
        const top = stack.pop();
        if (top === undefined) {
          // stray endif → literal
          current.push({ kind: "text", value: tok.raw });
          break;
        }
        const parent = stack[stack.length - 1];
        current = parent === undefined ? root : (parent.else ?? parent.thenBranch);
        break;
      }
    }
  }

  // Any `if` still on the stack never found its `endif` → unmatched.
  for (const node of stack) node.matched = false;
  return root;
}

// ─── Renderer (AST → string) ────────────────────────────────────────────────

function variableExists(key: string, vars: ReadonlyMap<string, string | null>): boolean {
  return vars.has(key) && vars.get(key) !== null;
}

function render(nodes: readonly Node[], vars: ReadonlyMap<string, string | null>): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "var":
        out += vars.get(node.key) ?? "";
        break;
      case "if": {
        if (node.matched) {
          const exists = variableExists(node.key, vars);
          const takeThen = node.negated ? !exists : exists;
          const branch = takeThen ? node.thenBranch : (node.else ?? EMPTY);
          out += render(branch, vars);
        } else {
          // Unmatched `if` → the tag is literal text; content still renders.
          out += node.raw;
          out += render(node.thenBranch, vars);
          if (node.else !== null) {
            out += "[else]";
            out += render(node.else, vars);
          }
        }
        break;
      }
    }
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve a template against a variable map → the final string.
 *
 * - `[type:name]` → the resolved value, or empty string when absent/null.
 * - `[if type:name] ... [endif]` → renders when the variable exists (string).
 * - `[if !type:name]` → renders when it does NOT exist.
 * - `[else]` provides the fallback branch.
 * - Unmatched `[if]`/`[endif]` tags pass through as literal text.
 */
export function parseTemplate(template: string, vars: ReadonlyMap<string, string | null>): string {
  const tokens = tokenize(template);
  const ast = parse(tokens);
  return render(ast, vars);
}

/**
 * Collect every variable key referenced by a template — from both insertion
 * (`[type:name]`) and conditionals (`[if type:name]` / `[if !type:name]`).
 * Used by the resolver to know which dynamic `file:<path>` variables to read.
 * Returns unique keys in first-seen order.
 */
export function extractVariables(template: string): string[] {
  const tokens = tokenize(template);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const tok of tokens) {
    if (tok.kind === "var" || tok.kind === "if") {
      if (!seen.has(tok.key)) {
        seen.add(tok.key);
        keys.push(tok.key);
      }
    }
  }
  return keys;
}
