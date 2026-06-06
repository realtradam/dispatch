# Dispatch — Constitution (root AGENTS.md)

> Loaded every session. Non-obvious, project-specific rules only. If a fresh
> frontier model could infer it from the code, it is NOT here (P6).
> The full design rationale lives in `notes/restructure-plan.md`.

## What this project is
A **minimal kernel + extensions** agent runtime. The kernel runs ONE agent turn
and hosts extensions. Every feature is an extension. Tiers: **kernel → core →
standard**. The web frontend is a SEPARATE repo (`../dispatch-web`), built to
the same methodology and consuming the backend's typed contracts (see
`notes/frontend-design.md`).

## Stack
Bun + TypeScript (strict, project references via `tsc -b`). Biome for
lint/format (tabs, double quotes, semicolons, width 100). Vitest for tests.
SQLite via `bun:sqlite`. AI SDK (`ai` + `@ai-sdk/*`) for providers.

## The non-negotiable architecture rules
- **Kernel touches NO I/O and names NO concrete feature.** It owns: contracts
  (the ABI), the extension host, the turn loop (`runTurn`), the event/hook bus.
  No `node:fs`, `bun:sqlite`, `node:child_process`, or network in the kernel.
- **Effects live at the edges, injected.** Decision logic is pure
  (input→output); I/O is passed in. This is for testability, not purity dogma.
- **No ambient/hidden state.** State is owned and passed explicitly. No stateful
  singletons. A turn's tool-set must be reproducible from its inputs.
- **One owner per unit.** Each file/module has exactly ONE agent that edits it.
  You may ONLY edit the files you are explicitly assigned. To change another
  unit, you do NOT edit it — you report the needed change up to the orchestrator.
- **Contracts are the only cross-unit surface.** You see other units' contracts,
  never their implementation. If you need to read another unit's code to do your
  job, the contract is incomplete — report that up.
- **Cross-extension coupling is anchored to exported TYPED symbols** (hook
  descriptors, service handles). No string-keyed cross-feature lookups — they
  must be a compile error, so `lsp references` can find every consumer.

## Tool dispatch (kernel turn loop)
Togglable `{ maxConcurrent, eager }`. `maxConcurrent`: 0=unlimited, 1=sequential,
2+=cap. `eager`: launch a tool the instant its call streams in vs. after the
step ends. **Default `{ maxConcurrent: 1, eager: true }`.**

## Durability (never leave the system broken)
Persist incrementally + append-only. Recovery is a PURE `reconcile(rows)` run on
load that repairs any partial turn (e.g. a tool-call with no result → synthesize
an error result). Status is derived/boot-swept, never trusted from disk.

## Testing (asymmetric — strict core, lenient shell)
- **Pure core / kernel:** zero internal mocks. A test that mocks our own module
  is a DESIGN BUG — fix the code (inject the effect), not the test. Demand high
  coverage; it's cheap because the code is pure.
- **Imperative shell** (orchestrator, transport, real adapters): a few
  integration tests against real / in-memory backends. Do NOT chase pure-unit
  coverage here, and do NOT mock sibling extensions.
- Mocking the OUTERMOST edge (real network/clock) is fine; mocking `@dispatch/*`
  is a smell.

## Commands
- `bun run typecheck` — `tsc -b --pretty`
- `bun run test` — vitest
- `bun run check` — biome (lint + format)

## Reports
When you finish a task, write a markdown report to `reports/<your-unit>.md`
(gitignored): what you built, the public surface, test/typecheck output, and any
contract gaps or change-requests for other units.

## Vocabulary
Use the canonical terms in `GLOSSARY.md`. Never invent a synonym for an existing
concept. Prefer standard/training-baked names.
