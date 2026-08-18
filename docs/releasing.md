# Releasing Zero

Zero ships as three downloadable products that must stay on one shared
version: the `zero` CLI/daemon (root `package.json`), the `zero-vscode`
extension (`packages/vscode`), and Zero IDE (`packages/desktop`). This doc
is the standard process for cutting a new version of all three and
publishing them as a GitHub release.

## Automated: `scripts/release.sh`

```
./scripts/release.sh 0.9.0
```

Run this from a clean `main` checkout. It does everything by hand described
below: bumps the version everywhere, runs tests and typecheck, builds all
three artifacts, commits, tags, pushes, and publishes the GitHub release
with the `.dmg` and `.vsix` attached.

If it fails partway through, the earlier steps' changes stay in place - fix
the problem and either re-run the script (the version-bump edits are
idempotent) or finish the remaining steps by hand from the section below.

## What the script automates (for doing it by hand, or auditing it)

1. **Bump the version** in every place it's duplicated:
   - `package.json` (root)
   - `packages/vscode/package.json`
   - `packages/desktop/package.json`
   - `packages/desktop/src-tauri/tauri.conf.json` (`"version"`)
   - `packages/desktop/src-tauri/Cargo.toml` (`version = "..."`)
   - `packages/desktop/src-tauri/Cargo.lock` needs the matching `app` entry
     regenerated - run `cargo check` in `packages/desktop/src-tauri` after
     editing `Cargo.toml` (this requires `packages/daemon/dist/` to already
     exist - build the sidecar first, see step 3).

   `zero --version` and the workbench's status-bar version indicator both
   read the root `package.json` directly (the daemon at runtime, the web
   client via a Vite build-time `define` - see
   `packages/web/vite.config.ts`), so that one file is the actual source of
   truth; the other four are duplicated because their respective tools
   (`vsce`, Cargo, Tauri) each need their own copy.

2. **Test:**
   ```
   bun test
   bun run typecheck
   ```

3. **Build the artifacts:**
   ```
   bun run --cwd packages/web build              # web UI (needed by both the sidecar and the vsix bundle indirectly)
   bun run --cwd packages/daemon build:sidecar    # daemon sidecar + portable node runtime, into packages/daemon/dist/
   (cd packages/vscode && bun run package)        # -> packages/vscode/zero-vscode-<version>.vsix
   bun run --cwd packages/desktop tauri build     # -> packages/desktop/src-tauri/target/release/bundle/{macos/Zero.app, dmg/Zero_<version>_aarch64.dmg}
   ```

   **Memory note:** the Tauri/wry dependency tree has caused severe `rustc`
   memory pressure (OOM-adjacent, single processes observed past 20-30GB
   RSS) on at least one dev machine, especially with a stale/bloated
   `target/` directory or default debug-symbol settings. If a build hangs
   or gets killed:
   ```
   cargo clean --manifest-path packages/desktop/src-tauri/Cargo.toml
   CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=off \
     bun run --cwd packages/desktop tauri build
   ```
   `scripts/release.sh` already sets these env vars and `-j1` by default.

4. **Commit, tag, push:**
   ```
   git add package.json packages/vscode/package.json packages/desktop/package.json \
     packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/Cargo.toml \
     packages/desktop/src-tauri/Cargo.lock
   git commit -m "chore: bump all Zero products to <version>"
   git tag v<version>
   git push origin main
   git push origin v<version>
   ```

5. **Publish the release:**
   ```
   gh release create v<version> \
     packages/desktop/src-tauri/target/release/bundle/dmg/Zero_<version>_aarch64.dmg \
     packages/vscode/zero-vscode-<version>.vsix \
     --title "Zero v<version>" \
     --notes "..."
   ```

## Known limitation: unsigned macOS build

The `.dmg` is only ad-hoc signed (no Apple Developer account is wired up),
so macOS Gatekeeper blocks first launch with "unidentified developer."
Downloaders need to right-click (or Control-click) `Zero.app` in Finder and
choose **Open** once. Fixing this for real requires an Apple Developer
account ($99/yr) plus a `notarytool` signing step in the build - out of
scope for now, tracked alongside Zero IDE's other deferred follow-ups (see
[`docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md`](superpowers/specs/2026-08-17-m8-zero-ide-design.md)
section 9).

## Platform scope

Builds today are macOS (Apple Silicon) only, matching Zero IDE's current
scope. Cross-platform packaging is a deferred follow-up, not something this
process handles yet.
