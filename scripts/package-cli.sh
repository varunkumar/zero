#!/usr/bin/env bash
# Packages a packages/daemon/scripts/build-sidecar.sh output directory
# into a distributable zero-<version>-<os>-<arch>.tar.gz for
# scripts/get-zero.sh. See
# docs/superpowers/specs/2026-08-31-cli-packaging-design.md section 3.
set -euo pipefail

if [ $# -lt 4 ] || [ $# -gt 5 ]; then
  echo "usage: $0 <os> <arch> <version> <dist-dir> [out-dir]" >&2
  echo "  os:       darwin | linux" >&2
  echo "  arch:     arm64 | x64" >&2
  echo "  version:  X.Y.Z (matches root package.json)" >&2
  echo "  dist-dir: a build-sidecar.sh output dir" >&2
  echo "  out-dir:  defaults to <repo-root>/dist-packages" >&2
  exit 1
fi

OS="$1"
ARCH="$2"
VERSION="$3"
DIST_DIR="$4"

case "$OS" in
  darwin|linux) ;;
  *) echo "error: os must be 'darwin' or 'linux' (got: $OS)" >&2; exit 1 ;;
esac
case "$ARCH" in
  arm64|x64) ;;
  *) echo "error: arch must be 'arm64' or 'x64' (got: $ARCH)" >&2; exit 1 ;;
esac
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be X.Y.Z (got: $VERSION)" >&2
  exit 1
fi

for required in zero-daemon-sidecar node-runtime web-dist plugins-ui; do
  if [ ! -e "$DIST_DIR/$required" ]; then
    echo "error: $DIST_DIR/$required not found - is $DIST_DIR a build-sidecar.sh output dir?" >&2
    exit 1
  fi
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${5:-$REPO_ROOT/dist-packages}"
PKG_NAME="zero-$VERSION-$OS-$ARCH"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
PKG_DIR="$WORK_DIR/$PKG_NAME"

mkdir -p "$PKG_DIR/bin"
cp "$DIST_DIR/zero-daemon-sidecar" "$PKG_DIR/zero-daemon-sidecar"
cp -R "$DIST_DIR/node-runtime" "$PKG_DIR/node-runtime"
cp -R "$DIST_DIR/web-dist" "$PKG_DIR/web-dist"
cp -R "$DIST_DIR/plugins-ui" "$PKG_DIR/plugins-ui"

cat > "$PKG_DIR/bin/zero" <<'WRAPPER_HEAD'
#!/bin/sh
# Wrapper for the compiled zero-daemon-sidecar binary: points it at the
# node-runtime/web-dist/plugins-ui bundled alongside it in this package -
# the same job packages/desktop/src-tauri/src/sidecar.rs does for Zero
# IDE. Resolves symlinks manually (not `readlink -f`, which macOS's BSD
# readlink doesn't support) since scripts/get-zero.sh installs this via a
# symlink in ~/.local/bin.
set -eu
WRAPPER_HEAD
cat >> "$PKG_DIR/bin/zero" <<EOF
# Baked in at package time: import.meta.url-relative version resolution
# (packages/daemon/src/version.ts) breaks inside a bun build --compile
# binary the same way ZERO_WEB_DIST's default lookup does - see that
# file's ZERO_VERSION override.
export ZERO_VERSION="$VERSION"
EOF
cat >> "$PKG_DIR/bin/zero" <<'WRAPPER_TAIL'
SCRIPT="$0"
while [ -L "$SCRIPT" ]; do
  LINK="$(readlink "$SCRIPT")"
  case "$LINK" in
    /*) SCRIPT="$LINK" ;;
    *) SCRIPT="$(dirname "$SCRIPT")/$LINK" ;;
  esac
done
ROOT="$(cd "$(dirname "$SCRIPT")/.." && pwd)"
export ZERO_PTY_NODE_BIN="$ROOT/node-runtime/node"
export ZERO_PTY_WORKER_DIR="$ROOT/node-runtime"
export ZERO_WEB_DIST="$ROOT/web-dist"
export ZERO_PLUGINS_DIR="$ROOT/plugins-ui"
exec "$ROOT/zero-daemon-sidecar" "$@"
WRAPPER_TAIL
chmod +x "$PKG_DIR/bin/zero"
chmod +x "$PKG_DIR/zero-daemon-sidecar"

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/$PKG_NAME.tar.gz"
tar -C "$WORK_DIR" -czf "$TARBALL" "$PKG_NAME"

echo "Packaged: $TARBALL"
