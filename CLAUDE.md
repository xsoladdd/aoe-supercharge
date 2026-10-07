# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## Releasing

When asked to release a version, follow these steps in order.

1. **Ask which bump first.** Before any release, ask the user: Major, Minor or Patch? Never choose one
   yourself.
2. **Check first.** Start from up-to-date `main`. The full suite must pass: vitest plus all Playwright
   engines.
3. **Branch.**
   - Major or Minor: always create a separate release branch from `main`, named `release/X.Y`
     (`release/1.0` for 1.0.0, `release/1.1` for 1.1.0), and make the release commit there.
   - Patch: no separate branch; commit on `main`.
4. **Bump the version** in one commit named `Release X.Y.Z`, as in `43ddf6b` ("Release 0.5.0"):
   - `packages/cli/package.json`: `version`
   - `package-lock.json`: the `packages/cli` entry's `version` (use `npm install --package-lock-only` or
     edit it by hand, then grep so no old version reference is left)
   - `CHANGELOG.md`: `## Unreleased` becomes `## X.Y.Z (YYYY-MM-DD)`
   - `README.md`: the `> Status: vX.Y.Z ...` line
5. **Push, and fast-forward `main`.** Push the release branch (Major/Minor), fast-forward `main` to the
   release commit and push `main`.
   **Do NOT create or push a `v*` tag.** A `v*` tag triggers `.github/workflows/release.yml`, which runs
   `npm publish`, and we don't want that.
6. **Install it on this machine** after the release:
   ```bash
   npm pack -w aoe-supercharge     # makes aoe-supercharge-X.Y.Z.tgz
   cd ~ && npm install -g <path-to>/aoe-supercharge-X.Y.Z.tgz
   supercharge start
   ```
   Then check that the daemon is up (`/healthz`); if `supercharge start` fails, run it again.
