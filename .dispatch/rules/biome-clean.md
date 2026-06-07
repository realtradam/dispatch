# Rule: biome is zero-tolerance (0 warnings, 0 infos)

`bunx biome check` must finish with ZERO warnings AND ZERO infos — not just zero errors.
"Clean" means there is no "Found N warnings" / "Found N infos" line at all. Fix the code;
NEVER add a `// biome-ignore` comment and NEVER relax the biome config to silence a finding.

Two findings recur — pre-empt them:
- **No postfix non-null assertions (`value!`).** Narrow with an explicit guard
  (`if (x === undefined) throw new Error(...)`) or a tiny `assertDefined` helper — this both
  proves the intent and narrows the type. (Most common in tests.)
- **No `useLiteralKeys`.** Use dot access for identifier keys (`obj.foo`); reserve bracket
  access for genuinely dotted / dynamic keys (`obj["a.b"]`).
