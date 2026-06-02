# Upstream bug: `cs` fuzzy search only matches substitutions, not insertions/deletions

> Drafted for a potential PR/issue to [boyter/cs](https://github.com/boyter/cs).
> Dispatch ships a local fix as `docker/cs/fuzzy-distance.patch` (applied to the
> pinned cs build); this document is the upstream-facing writeup.

## Summary

`cs`'s fuzzy operator `term~N` is documented as *"fuzzy match within 1 or 2
distance"* (`cs --help`, README), i.e. Levenshtein edit distance. In practice it
only ever matches **substitutions**: a mid-word **insertion** or **deletion**
that is genuinely edit distance 1 does **not** match.

- `computSlipAngle~1` does **not** find `computeSlipAngle` (one dropped `e`) — edit distance 1.
- `houss~1` finds `house` (works — it's a substitution), but `hose~1` does **not** find `house` (one inserted `u`) — edit distance 1.

Affected version: `cs version 3.1.0` (observed at commit `697e0bf`). The defect
is not reported in the issue tracker (checked all 51 open/closed issues + PRs as
of this writing).

## Root cause

`pkg/search/executor.go` implements fuzzy matching by scanning only
**same-length** windows of the content. For a term of length `L` it compares
every `L`-character substring against the term:

```go
// fuzzyContains checks if any same-length substring of content matches
// the term within the given edit distance (substitution-based matching).
func fuzzyContains(content, term string, maxDist, termLen int) bool {
	contentLen := len(content)
	if contentLen == 0 || termLen == 0 || termLen > contentLen {
		return false
	}
	for i := 0; i <= contentLen-termLen; i++ {
		window := content[i : i+termLen]      // <-- always exactly termLen long
		if levenshtein(window, term) <= maxDist {
			return true
		}
	}
	return false
}
```

`fuzzyFind` (which produces match locations) has the same structure. Because
every candidate `window` is exactly `termLen` characters, the only edit the
comparison can ever observe is a **substitution**. An insertion or deletion
changes the string length by one, so the matching substring of the content is
`termLen ± 1` long and is never formed — hence never compared.

This also makes one of the existing tests assert buggy behavior:
`{"Fuzzy Distance 2", "hovze~2", ...}` expects to match only `house`'s 5-char
window, but `hovze` is also within distance 2 of the 4-char window `" ove"`
elsewhere in the corpus — a match the same-length scan structurally cannot see.

## Fix

Scan windows of **every plausible length** in
`[termLen - maxDist, termLen + maxDist]` (clamped to ≥ 1) at each offset, and
keep the best (lowest-distance) window. A Levenshtein distance of `d` requires
the two strings' lengths to differ by at most `d` (each insert/delete shifts
length by one), so this range is exactly the set of window lengths that can be
within `maxDist`. `fuzzyFind` records the best window at each start and then
advances past it, so a single logical match doesn't produce a swarm of
overlapping locations.

See `docker/cs/fuzzy-distance.patch` for the full diff. Shape:

```go
func fuzzyWindowBounds(termLen, maxDist int) (int, int) {
	minLen := termLen - maxDist
	if minLen < 1 {
		minLen = 1
	}
	return minLen, termLen + maxDist
}

// bestFuzzyMatchAt returns the length of the lowest-distance window starting at
// i that is within maxDist of term, or -1. Ties prefer the length closest to
// termLen.
func bestFuzzyMatchAt(content, term string, i, maxDist, minLen, maxLen int) int { ... }
```

## Complexity note

Worst-case work per offset goes from one `levenshtein` call to `2*maxDist + 1`
calls. Since `cs` only supports `~1` and `~2`, that's a small constant factor
(≤ 5×) and only on fuzzy queries, which are rare relative to keyword/regex
searches. No measurable impact in practice.

## Verification

The change keeps `go test ./pkg/search/... ./pkg/ranker/... ./...` green (with
the one buggy assertion corrected) and adds explicit mid-word insertion/deletion
cases:

```go
{"Fuzzy Distance 2", "houze~2", false, []string{"src/main/file1.go"}},
{"Fuzzy Distance 1 deletion", "hose~1", false, []string{"src/main/file1.go"}},   // hose -> house (insert 'u')
{"Fuzzy Distance 1 insertion", "houxse~1", false, []string{"src/main/file1.go"}}, // houxse -> house (delete 'x')
```

End-to-end against a real `.luau` codebase, all four of these now match (they
returned empty before):

```
computSlipAngle~1  -> computeSlipAngle   (CarPhysics.luau)
LauncTuning~1      -> LaunchTuning        (LaunchController.luau)
LaunchTunin~1      -> LaunchTuning        (LaunchTuning.luau)     # already worked (suffix)
TireFrictio~1      -> TireFriction        (CarPhysics.luau)       # already worked (suffix)
```
