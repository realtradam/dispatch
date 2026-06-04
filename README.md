# Dispatch (architecture rewrite)

Minimal **kernel + extensions** agent runtime. The kernel runs one agent turn and
hosts extensions; every feature is an extension. Tiers: kernel → core → standard.

- Design & rationale: `notes/restructure-plan.md`
- Agent constitution: `AGENTS.md`
- Vocabulary: `GLOSSARY.md`

## Dev
```
bun install
bun run typecheck   # tsc -b
bun run test        # vitest
bun run check       # biome
```

Status: **MVP in progress** — kernel + core extensions to complete one turn
against OpenCode Go (flash), verified via a thin HTTP `/chat` + curl.
