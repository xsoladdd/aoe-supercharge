# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Releasing

Trunk and tag. Every change reaches `main` through a pull request that the user reviews and merges. A
release is a `Release X.Y.Z` commit on `main` plus a `vX.Y.Z` tag. There are no `release/X.Y` branches:
cut one from a tag only when an older version needs a patch after `main` has moved on.

Every PR adds its own `## Unreleased` entry to `CHANGELOG.md` (and updates the README where behaviour
changes), so a release is only the version bump and the tag.

When asked to release a version, follow these steps in order.

1. **Ask which bump first.** Before any release, ask the user: Major, Minor or Patch? Never choose one
   yourself.
2. **Check first.** Start from up-to-date `main`, on a branch named `release-X.Y.Z`. The full suite must
   pass: vitest plus all Playwright engines.
3. **Bump the version** in one commit named `Release X.Y.Z`, as in `43ddf6b` ("Release 0.5.0"):
   - `packages/cli/package.json`: `version`
   - `package-lock.json`: the `packages/cli` entry's `version` (use `npm install --package-lock-only` or
     edit it by hand, then grep so no old version reference is left)
   - `CHANGELOG.md`: `## Unreleased` becomes `## X.Y.Z (YYYY-MM-DD)`
   - `README.md`: the `> Status: vX.Y.Z ...` line, and the version in the install URL
4. **Open a PR** titled `Release X.Y.Z` and stop. The user reviews and merges it. Use a merge or squash
   commit whose first line starts with `Release X.Y.Z`: that is what the workflow looks for.
5. **CI tags and releases.** On the merge, `.github/workflows/release.yml` sees the `Release X.Y.Z` commit,
   runs the tests, runs `npm pack -w aoe-supercharge`, and creates the GitHub Release `vX.Y.Z` (and with it
   the tag) with the tarball attached and the CHANGELOG section as its notes. The README's install path
   points at that tarball. `npm publish` and the Homebrew tap step run only once `NPM_TOKEN` (and
   `TAP_TOKEN`) exist as repository secrets; until then they are skipped. Nobody runs `gh release create`
   or pushes a tag by hand (pushing a `vX.Y.Z` tag by hand still releases it the same way).
6. **Install it on this machine** after the release, once the Release is up:
   ```bash
   git switch main && git pull
   npm pack -w aoe-supercharge     # makes aoe-supercharge-X.Y.Z.tgz
   cd ~ && npm install -g <path-to>/aoe-supercharge-X.Y.Z.tgz
   supercharge start
   ```
   Then check that the daemon is up (`/healthz`); if `supercharge start` fails, run it again.

### Who does what

| Step                                         | Who                                          |
| -------------------------------------------- | -------------------------------------------- |
| Ask Major/Minor/Patch, run the suite         | Claude                                       |
| Bump, commit `Release X.Y.Z`, push the branch, open the PR | Claude                         |
| Review and merge the PR (into `main`)        | The user                                     |
| Tag `vX.Y.Z`, test, pack, create the Release | CI (`release.yml`)                           |
| Pack, `npm install -g`, `supercharge start`, `/healthz` | Claude, after the Release is up   |
| Add `NPM_TOKEN`, `TAP_TOKEN`, choose a license | The user (one time, when npm and Homebrew are wanted) |

Claude Code's auto mode blocks pushes to `main` and `gh release create` from Claude sessions. Under this
flow Claude does neither: it pushes a branch and opens a PR, and CI does the rest. If Claude is ever
asked to cut a patch for an old version, it branches from the tag (`release/X.Y`), opens a PR to that
branch, and the user pushes the tag (CI releases a pushed tag the same way).
