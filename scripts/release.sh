#!/usr/bin/env bash
# Bumps every Zero product to a new version, builds release artifacts, and
# publishes a GitHub release. See docs/releasing.md for the full process
# this automates (and what to do if a step here fails partway through).
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <version> [changelog-file]   (e.g. $0 0.9.0)" >&2
  echo "  changelog-file: optional markdown file whose content is spliced" >&2
  echo "  into the release notes under a '### Changelog' heading. See the" >&2
  echo "  /release skill (.claude/skills/release/SKILL.md), which generates" >&2
  echo "  one from git history and is the recommended way to invoke this." >&2
  exit 1
fi
VERSION="$1"
CHANGELOG_FILE="${2:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (got: $VERSION)" >&2
  exit 1
fi
if [ -n "$CHANGELOG_FILE" ]; then
  if [ ! -f "$CHANGELOG_FILE" ]; then
    echo "error: changelog file not found: $CHANGELOG_FILE" >&2
    exit 1
  fi
  # Resolve to an absolute path before the cd below, so a path relative
  # to the caller's cwd (not the repo root) still works.
  CHANGELOG_FILE="$(cd "$(dirname "$CHANGELOG_FILE")" && pwd)/$(basename "$CHANGELOG_FILE")"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRANCH="$(git branch --show-current)"
if [ "$BRANCH" != "main" ]; then
  echo "error: release.sh must be run from main (currently on $BRANCH)" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean - commit or stash first" >&2
  git status --short
  exit 1
fi
for cmd in bun cargo gh docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' is required but wasn't found on PATH" >&2
    exit 1
  fi
done

echo "==> Bumping version to $VERSION"
for f in package.json packages/vscode/package.json packages/desktop/package.json \
  packages/desktop/src-tauri/tauri.conf.json; do
  bun -e '
    const [file, version] = process.argv.slice(1);
    const path = require("node:path");
    const abs = path.resolve(file);
    const text = require("node:fs").readFileSync(abs, "utf8");
    const updated = text.replace(/"version":\s*"[0-9]+\.[0-9]+\.[0-9]+"/, `"version": "${version}"`);
    if (updated === text) throw new Error(`no "version" field found in ${file}`);
    require("node:fs").writeFileSync(abs, updated);
  ' "$f" "$VERSION"
done
bun -e '
  const [file, version] = process.argv.slice(1);
  const path = require("node:path");
  const abs = path.resolve(file);
  const text = require("node:fs").readFileSync(abs, "utf8");
  const updated = text.replace(/^version = "[0-9]+\.[0-9]+\.[0-9]+"/m, `version = "${version}"`);
  if (updated === text) throw new Error(`no top-level version field found in ${file}`);
  require("node:fs").writeFileSync(abs, updated);
' packages/desktop/src-tauri/Cargo.toml "$VERSION"

echo "==> Building packages/web (needed by the sidecar and the Cargo.lock sync build below)"
bun run --cwd packages/web build

echo "==> Building the daemon sidecar (needed for cargo check's resource validation)"
bun run --cwd packages/daemon build:sidecar

echo "==> Syncing Cargo.lock to the new version"
(cd packages/desktop/src-tauri && \
  env CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_SPLIT_DEBUGINFO=off cargo check)

echo "==> Running tests and typecheck"
bun test
bun run typecheck

echo "==> Building the VS Code extension .vsix"
(cd packages/vscode && bun run package)
VSIX="packages/vscode/zero-vscode-$VERSION.vsix"
if [ ! -f "$VSIX" ]; then
  echo "error: expected $VSIX after vsce package, not found" >&2
  exit 1
fi

echo "==> Packaging the zero CLI for macOS arm64 (reusing the sidecar build above)"
bash scripts/package-cli.sh darwin arm64 "$VERSION" packages/daemon/dist
CLI_MACOS="dist-packages/zero-$VERSION-darwin-arm64.tar.gz"
if [ ! -f "$CLI_MACOS" ]; then
  echo "error: expected $CLI_MACOS after package-cli.sh, not found" >&2
  exit 1
fi

echo "==> Building and packaging the zero CLI for Linux x64 + arm64 (Docker/QEMU - this is slow)"
bash scripts/build-linux-sidecar.sh x64
bash scripts/package-cli.sh linux x64 "$VERSION" packages/daemon/dist-linux-x64
bash scripts/build-linux-sidecar.sh arm64
bash scripts/package-cli.sh linux arm64 "$VERSION" packages/daemon/dist-linux-arm64
CLI_LINUX_X64="dist-packages/zero-$VERSION-linux-x64.tar.gz"
CLI_LINUX_ARM64="dist-packages/zero-$VERSION-linux-arm64.tar.gz"
for f in "$CLI_LINUX_X64" "$CLI_LINUX_ARM64"; do
  if [ ! -f "$f" ]; then
    echo "error: expected $f after package-cli.sh, not found" >&2
    exit 1
  fi
done

echo "==> Building the desktop app (release profile - this is the slow step)"
# -j1 and no debug symbols: this repo's Tauri/wry dependency tree has caused
# severe rustc memory pressure on at least one dev machine at higher
# parallelism (see docs/releasing.md). If you hit OOM/hangs even at -j1,
# `cargo clean packages/desktop/src-tauri` and retry.
(cd packages/desktop && \
  env CARGO_BUILD_JOBS=1 CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO=off \
  bun run tauri build)
DMG="packages/desktop/src-tauri/target/release/bundle/dmg/Zero_${VERSION}_aarch64.dmg"
if [ ! -f "$DMG" ]; then
  echo "error: expected $DMG after tauri build, not found" >&2
  exit 1
fi

echo "==> Committing the version bump"
git add package.json packages/vscode/package.json packages/desktop/package.json \
  packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/Cargo.toml \
  packages/desktop/src-tauri/Cargo.lock
git commit -m "chore: bump all Zero products to $VERSION"

echo "==> Tagging and pushing"
git tag "v$VERSION"
git push origin main
git push origin "v$VERSION"

echo "==> Creating the GitHub release"
NOTES="$(mktemp)"
cat > "$NOTES" <<EOF
## Zero v$VERSION

### Downloads

- **Zero IDE (macOS, Apple Silicon)** - \`Zero_${VERSION}_aarch64.dmg\`. Ad-hoc
  signed only - macOS Gatekeeper will block the first launch as
  "unidentified developer." Right-click (or Control-click) the app in
  Finder and choose **Open** to bypass this once.
- **Zero VS Code extension** - \`zero-vscode-${VERSION}.vsix\`. Install with:
  \`\`\`
  code --install-extension zero-vscode-${VERSION}.vsix
  \`\`\`
- **Zero / Zero Agents / Zero Claude (CLI, macOS arm64 + Linux x64/arm64)** -
  install with:
  \`\`\`
  curl -fsSL https://raw.githubusercontent.com/varunkumar/zero/main/scripts/get-zero.sh | sh
  \`\`\`
EOF
if [ -n "$CHANGELOG_FILE" ]; then
  { echo ""; echo "### Changelog"; echo ""; cat "$CHANGELOG_FILE"; } >> "$NOTES"
fi
cat >> "$NOTES" <<EOF

See [\`docs/releasing.md\`](https://github.com/varunkumar/zero/blob/main/docs/releasing.md) for how this release was built.
EOF
gh release create "v$VERSION" "$DMG" "$VSIX" "$CLI_MACOS" "$CLI_LINUX_X64" "$CLI_LINUX_ARM64" \
  --title "Zero v$VERSION" \
  --notes-file "$NOTES"
rm -f "$NOTES"

echo "==> Done: https://github.com/varunkumar/zero/releases/tag/v$VERSION"
