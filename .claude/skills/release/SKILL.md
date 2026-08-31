---
name: release
description: Use when cutting a new Zero release, bumping the version across Zero/Zero Agents/Zero IDE/the VS Code extension, or preparing a changelog for a GitHub release.
---

# Release

## Overview

Guides cutting a Zero release: drafts a changelog from git history since the
last tag, confirms a version number with you, and hands off to
`scripts/release.sh` (which builds, tests, and publishes everything). See
`docs/releasing.md` for what that script does under the hood and how to
recover if it fails partway through.

## When to Use

- The user asks to "cut a release", "release a new version", "bump the
  version", or "prepare a changelog".
- Not for: publishing a single product in isolation (there's no supported
  way to do that - Zero, Zero Agents, Zero IDE, and the VS Code extension
  always ship together on one version, per `docs/releasing.md`).

## Steps

1. **Confirm the branch is releasable.** Run `git status --porcelain` and
   `git branch --show-current`. If the tree isn't clean or the branch isn't
   `main`, stop and tell the user - `scripts/release.sh` enforces both and
   will refuse to run otherwise.

2. **Find the last released tag and the commits since it:**
   ```
   git describe --tags --abbrev=0
   git log <tag>..HEAD --pretty=format:"%s|%h" --no-merges
   ```

3. **Group commits by conventional-commit prefix** into buckets, in this
   order: `feat` → Features, `fix` → Fixes, `docs` → Docs, `chore`/`build`/
   `ci` → Chores, everything else (including unprefixed subjects) → Other.
   Render each bucket as a `### <Bucket>` heading with `- <subject> (<short
   sha>)` bullets; skip empty buckets.

4. **Suggest a version bump** from the current version in root
   `package.json`: any `feat:` commit → minor bump; otherwise → patch bump;
   any commit whose subject contains `BREAKING CHANGE` or a `!` right after
   the type (e.g. `feat!:`) → major bump instead, regardless of the above.
   Show the suggestion and ask the user to confirm or override it.

5. **Write the changelog to a temp file**, show the user the full draft
   (version + changelog), and get their explicit go-ahead before
   proceeding - this is the one confirmation gate; `scripts/release.sh`
   itself runs straight through once started (build → test → tag → push →
   publish), so this is the last point to catch a wrong version or a
   miscategorized entry.

6. **Run the release:**
   ```
   ./scripts/release.sh <version> <changelog-file>
   ```
   Report the release URL the script prints on success
   (`==> Done: https://github.com/varunkumar/zero/releases/tag/v<version>`).
   If it fails partway through, don't retry blindly - read the error, then
   see `docs/releasing.md`'s "If it fails partway through" note (the
   version-bump edits are idempotent, so re-running after a fix is usually
   safe) and its per-step manual instructions for finishing by hand.

## Quick Reference

| Step | Command |
|---|---|
| Last tag | `git describe --tags --abbrev=0` |
| Commits since | `git log <tag>..HEAD --pretty=format:"%s\|%h" --no-merges` |
| Run the release | `./scripts/release.sh <version> [changelog-file]` |

## Common Mistakes

- **Skipping the confirmation gate.** `scripts/release.sh` pushes to `main`,
  pushes a tag, and publishes a GitHub release with no pauses in between -
  always show the drafted version + changelog and wait for a yes before
  running it.
- **Treating an unprefixed commit as "no changelog entry needed".** Put it
  in Other rather than dropping it; a human reviewing the changelog should
  see everything that shipped, not just what happened to use a conventional
  prefix.
- **Passing the changelog file as a relative path from the wrong
  directory.** `scripts/release.sh` resolves it to an absolute path before
  it `cd`s to the repo root, so a path relative to your current shell's
  cwd works correctly - just make sure it's the file you actually wrote in
  step 5, not a stale one from a previous attempt.
