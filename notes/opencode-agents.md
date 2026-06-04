# Spawning OpenCode Agents via CLI

## Non-interactive (headless) run

`opencode run` streams output to stdout and exits — no TUI opens.

```bash
opencode run "your prompt here"
```

## Key flags

| Flag | Short | Purpose |
|------|-------|---------|
| `--dir` | | Working directory for the agent |
| `-m provider/model` | `--model` | Which model to use |
| `-f path/to/file` | `--file` | Attach a file to the message |
| `--agent` | | Which agent profile to use |
| `--format json` | | Raw JSON events instead of formatted text |
| `--dangerously-skip-permissions` | | Auto-approve all permissions (dangerous!) |

## Examples

### Run with a specific model and CWD

```bash
opencode run --dir /path/to/project -m opencode-go/qwen3.7-max "your prompt"
```

### Attach a file as context

```bash
opencode run --dir /path/to/project -m opencode-go/qwen3.7-max -f prompt.md "follow the instructions in the attached file"
```

### Pipe file content as the prompt itself

```bash
opencode run --dir /path/to/project -m opencode-go/qwen3.7-max "$(cat prompt.md)"
```

### Use a specific agent profile

```bash
opencode run --dir /path/to/project --agent my-agent -f prompt.md "do it"
```

### JSON output for scripting

```bash
opencode run --dir /path/to/project -m opencode-go/qwen3.7-max -f prompt.md "do it" --format json
```

## API key configuration

- **Env var:** `ANTHROPIC_API_KEY=sk-... opencode run ...` (provider-specific)
- **Persisted:** `opencode auth login --provider anthropic`
- **Project `.env`:** opencode reads `.env` on startup

## Listing available agents

```bash
opencode agent list
```
