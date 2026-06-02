# Deploying the `cs` / `search_code` binary to the Artix (s6) cyberdeck

## TL;DR

The `search_code` agent tool shells out to a `cs` (code spelunker) binary. This
feature provisions that binary on **two** deployment paths automatically:

| Path | Mechanism | `cs` ends up at |
| --- | --- | --- |
| `bin/up` | Docker (`Dockerfile` / `Dockerfile.dev`, `cs-builder` stage) | `/usr/local/bin/cs` |
| `bin/service install` | native Arch package `code-search` (built by `packaging/PKGBUILD`, installed by `bin/install-pkg`) | `/usr/bin/cs` |

There is a **third** path — the Artix cyberdeck box — that is deployed by a
personal script living **outside this repo**
(`~/projects/cyberdeck/sync-dispatch.sh`). That script has now been edited (the
5 small additions below) so the Artix box also gets the patched `cs`. Before the
edit, `search_code` on the cyberdeck returned its graceful
`Error: search_code requires the 'cs' binary ...` message on every call.

This file documents that follow-up (now applied). It is committed so the change
isn't forgotten and can be re-derived if the cyberdeck script is ever reset; the
actual edit lives in the cyberdeck repo, not here.

---

## Why this is needed

`packaging/PKGBUILD` now builds a `code-search` split package (a patched,
statically-linked `cs` pinned to upstream commit
`697e0bf194bbc7a4a877e5170c70618989fc92e7`, tag `v3.1.0`, plus two patches:
`docker/cs/luau-declarations.patch` for Roblox `.luau` declaration support and
`docker/cs/fuzzy-distance.patch` for correct fuzzy edit-distance matching). It
installs `cs` to `/usr/bin/cs`.

`code-search` is a plain static binary with **no init-system coupling**, so it
installs and runs identically on Artix (Arch-based, `pacman`/`x86_64`). The only
gap is that `sync-dispatch.sh` — which pushes packages to the Artix box and
`pacman -U`s them — has a hardcoded two-package list (`dispatch` + `dispatch-s6`)
and does not yet include `code-search`.

> Note: `sync-dispatch.sh` builds and pushes packages from the **main** dispatch
> checkout (`/home/tradam/projects/dispatch/packaging`), so this edit only
> becomes meaningful **after this feature branch is merged to `dev`** and that
> checkout rebuilds packages (`bin/build-pkg` / `sync-dispatch.sh --build`).

---

## The edit applied to `~/projects/cyberdeck/sync-dispatch.sh`

Five small additions (the four below plus mirroring `PKG_CS` into the generated
remote-script preamble alongside `PKG_DISPATCH` / `PKG_S6`). This edit has been
applied. To deploy, run `sync-dispatch.sh --build` (the `--build` flag rebuilds
the packages first, producing the new `code-search-*.pkg.tar.zst` that now
carries both the Luau and fuzzy patches).

### 1. Declare the package name (next to `PKG_DISPATCH` / `PKG_S6`)

```sh
PKG_DISPATCH="dispatch-0.0.1-1-x86_64.pkg.tar.zst"
PKG_S6="dispatch-s6-0.0.1-1-x86_64.pkg.tar.zst"
PKG_CS="code-search-0.0.1-1-x86_64.pkg.tar.zst"      # <-- add
```

### 2. Add it to the "package exists" pre-check loop

```sh
for pkg in "$PKG_DISPATCH" "$PKG_S6" "$PKG_CS"; do   # <-- add "$PKG_CS"
    if [ ! -f "${PKG_DIR}/${pkg}" ]; then
        echo "ERROR: ${PKG_DIR}/${pkg} not found. Run with --build or 'bin/build-pkg' first." >&2
        exit 1
    fi
done
```

### 3. Add it to the `scp` upload

```sh
scp -q "${PKG_DIR}/${PKG_DISPATCH}" "${PKG_DIR}/${PKG_S6}" "${PKG_DIR}/${PKG_CS}" "${TARGET}:/tmp/"
#                                                          ^^^^^^^^^^^^^^^^^^^^^^^ add
```

### 4. Add it to the remote `pacman -U` and cleanup `rm`

Inside the remote script heredoc:

```sh
pacman -U --noconfirm "/tmp/$PKG_DISPATCH" "/tmp/$PKG_S6" "/tmp/$PKG_CS"
rm -f "/tmp/$PKG_DISPATCH" "/tmp/$PKG_S6" "/tmp/$PKG_CS"
```

> The remote script is generated inside `sync-dispatch.sh` and references
> `$PKG_CS` via the same variable-expansion mechanism already used for
> `$PKG_DISPATCH` / `$PKG_S6`. Make sure `PKG_CS` is exported/substituted into
> the remote script the same way those two are (search the script for every
> place `PKG_S6` appears and mirror it for `PKG_CS`).

No s6 service changes are needed — `code-search` ships only a binary, not a
service, so the existing `s6 repository sync` / `s6 set enable` dance is
unaffected.

---

## Verifying on the Artix box after sync

```sh
cs --version            # -> cs version 3.1.0
which cs                # -> /usr/bin/cs
pacman -Q code-search   # -> code-search 0.0.1-1
```

Then, in a Dispatch tab with the `search_code` permission enabled, run a search;
it should return ranked results instead of the "cs binary not found" error.

For a `.luau` sanity check (confirms the Luau patch is present), search a Roblox
project with `only: "declarations"` — `function` / `type` / `export type` lines
should be detected.

For a fuzzy sanity check (confirms the fuzzy patch is present), a mid-word
deletion should match, e.g. `cs -- 'computSlipAngle~1'` finds `computeSlipAngle`
(returns empty on an unpatched cs).

---

## If you ever decouple `cs` from this repo

`code-search` is intentionally a standalone package (own name, own
`/usr/bin/cs`, upstream MIT license shipped). If `cs` later graduates to its own
AUR/repo package, the cleaner end state is to drop `package_code-search()` from
`packaging/PKGBUILD` and instead declare a `depends=('code-search')` (or the AUR
name) on the `dispatch` package — but as of this writing **no official or AUR
package for boyter/cs exists** (the AUR `cs` is an unrelated `ls`-with-icons
tool), so building it here is the correct approach.
