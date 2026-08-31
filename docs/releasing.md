# Releasing Zero

Zero ships as three downloadable products that must stay on one shared
version: the `zero` CLI/daemon (root `package.json`), the `zero-vscode`
extension (`packages/vscode`), and Zero IDE (`packages/desktop`). This doc
is the standard process for cutting a new version of all three and
publishing them as a GitHub release.

## Recommended: the `/release` skill

```
/release
```

Walks through cutting a release interactively: finds the last released tag,
drafts a changelog from the commits since then (grouped into Features /
Fixes / Docs / Chores / Other by conventional-commit prefix), suggests a
version bump from that changelog's content, and pauses for your
confirmation before handing off to `scripts/release.sh` below with the
changelog attached. See `.claude/skills/release/SKILL.md`.

## Automated: `scripts/release.sh`

```
./scripts/release.sh 0.9.0
./scripts/release.sh 0.9.0 /path/to/changelog.md   # optional: splice a
                                                    # pre-written changelog
                                                    # into the release notes
```

Run this from a clean `main` checkout. It does everything by hand described
below: bumps the version everywhere, runs tests and typecheck, builds all
three artifacts, commits, tags, pushes, and publishes the GitHub release
with the `.dmg`, `.vsix`, and the three `zero` CLI tarballs attached. The
optional second argument is a markdown file whose content is spliced into
the release notes under a `### Changelog` heading - the `/release` skill
above generates one automatically; write your own by hand if you're running
this script directly instead.

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
   ./scripts/package-cli.sh darwin arm64 <version> packages/daemon/dist   # -> dist-packages/zero-<version>-darwin-arm64.tar.gz
   ./scripts/build-linux-sidecar.sh x64           # Docker/QEMU build -> packages/daemon/dist-linux-x64/
   ./scripts/package-cli.sh linux x64 <version> packages/daemon/dist-linux-x64      # -> dist-packages/zero-<version>-linux-x64.tar.gz
   ./scripts/build-linux-sidecar.sh arm64         # Docker/QEMU build -> packages/daemon/dist-linux-arm64/
   ./scripts/package-cli.sh linux arm64 <version> packages/daemon/dist-linux-arm64  # -> dist-packages/zero-<version>-linux-arm64.tar.gz
   (cd packages/vscode && bun run package)        # -> packages/vscode/zero-vscode-<version>.vsix
   bun run --cwd packages/desktop tauri build     # -> packages/desktop/src-tauri/target/release/bundle/{macos/Zero.app, dmg/Zero_<version>_aarch64.dmg}
   ```

   `scripts/get-zero.sh` isn't a build step - it's the `curl | sh` installer
   end users run to fetch and install these published tarballs, so it only
   needs to keep matching the asset names produced above.

   The two Linux builds run inside Docker containers of the matching
   architecture (`docker/linux-build.Dockerfile`), since node-pty's native
   addon and the bundled `node` binary are architecture-specific and can't
   be cross-compiled from macOS. `linux/arm64` runs natively under Docker
   Desktop's VM on an Apple Silicon machine; `linux/amd64` runs under QEMU
   emulation and is the slow step in a release - budget tens of minutes
   for it.

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
     dist-packages/zero-<version>-darwin-arm64.tar.gz \
     dist-packages/zero-<version>-linux-x64.tar.gz \
     dist-packages/zero-<version>-linux-arm64.tar.gz \
     --title "Zero v<version>" \
     --notes "..."
   ```

   The `--notes` content is what `scripts/release.sh` builds from its
   `NOTES` heredoc, plus the changelog (if any) spliced in under a
   `### Changelog` heading - see the `/release` skill above for how that's
   generated automatically.

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

- **Zero IDE** (`.dmg`) and the **VS Code extension** (`.vsix`) are macOS
  (Apple Silicon) and cross-platform respectively, unchanged by this
  section.
- **The `zero` CLI** (Zero / Zero Agents / Zero Claude Plugin) ships as
  tarballs for macOS arm64, Linux x64, and Linux arm64 - see
  `docs/superpowers/specs/2026-08-31-cli-packaging-design.md` for the full
  design. Windows and macOS x64 (Intel) aren't built yet.
- All builds remain manual/local from one dev machine - there's no CI in
  this repo. The Linux builds' Docker/QEMU step is the main added release
  cost (see step 3 above).
