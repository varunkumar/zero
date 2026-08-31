#!/usr/bin/env bash
# Smoke test for scripts/package-cli.sh. Builds a fake sidecar dist dir
# (no real bun/docker build needed) and verifies:
#   - the tarball has the expected layout
#   - bin/zero resolves paths relative to itself (not the build machine),
#     both when run directly and through a symlink (mirrors how
#     scripts/get-zero.sh installs it)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DIST_DIR="$WORK/fake-dist"
mkdir -p "$DIST_DIR/node-runtime" "$DIST_DIR/web-dist" "$DIST_DIR/plugins-ui"
cat > "$DIST_DIR/zero-daemon-sidecar" <<'EOF'
#!/bin/sh
echo "ZERO_PTY_NODE_BIN=$ZERO_PTY_NODE_BIN"
echo "ZERO_PTY_WORKER_DIR=$ZERO_PTY_WORKER_DIR"
echo "ZERO_WEB_DIST=$ZERO_WEB_DIST"
echo "ZERO_PLUGINS_DIR=$ZERO_PLUGINS_DIR"
echo "args=$*"
EOF
chmod +x "$DIST_DIR/zero-daemon-sidecar"
touch "$DIST_DIR/node-runtime/node"
chmod +x "$DIST_DIR/node-runtime/node"

OUT_DIR="$WORK/out"
bash "$REPO_ROOT/scripts/package-cli.sh" darwin arm64 9.9.9 "$DIST_DIR" "$OUT_DIR"

TARBALL="$OUT_DIR/zero-9.9.9-darwin-arm64.tar.gz"
if [ ! -f "$TARBALL" ]; then
  echo "FAIL: expected tarball not found: $TARBALL" >&2
  exit 1
fi

EXTRACT="$WORK/extract"
mkdir -p "$EXTRACT"
tar -C "$EXTRACT" -xzf "$TARBALL"

PKG_DIR="$EXTRACT/zero-9.9.9-darwin-arm64"
for expected in bin/zero zero-daemon-sidecar node-runtime web-dist plugins-ui; do
  if [ ! -e "$PKG_DIR/$expected" ]; then
    echo "FAIL: expected $expected in package, not found" >&2
    exit 1
  fi
done
if [ ! -x "$PKG_DIR/bin/zero" ]; then
  echo "FAIL: bin/zero is not executable" >&2
  exit 1
fi

# Relocate the package to prove bin/zero resolves paths relative to
# itself, not to any build-machine-specific path.
RELOCATED="$WORK/relocated-elsewhere"
mv "$PKG_DIR" "$RELOCATED"

OUTPUT="$("$RELOCATED/bin/zero" --some-arg)"
echo "$OUTPUT" | grep -q "ZERO_PTY_NODE_BIN=$RELOCATED/node-runtime/node" || { echo "FAIL: ZERO_PTY_NODE_BIN wrong"; echo "$OUTPUT" >&2; exit 1; }
echo "$OUTPUT" | grep -q "ZERO_PTY_WORKER_DIR=$RELOCATED/node-runtime" || { echo "FAIL: ZERO_PTY_WORKER_DIR wrong"; echo "$OUTPUT" >&2; exit 1; }
echo "$OUTPUT" | grep -q "ZERO_WEB_DIST=$RELOCATED/web-dist" || { echo "FAIL: ZERO_WEB_DIST wrong"; echo "$OUTPUT" >&2; exit 1; }
echo "$OUTPUT" | grep -q "ZERO_PLUGINS_DIR=$RELOCATED/plugins-ui" || { echo "FAIL: ZERO_PLUGINS_DIR wrong"; echo "$OUTPUT" >&2; exit 1; }
echo "$OUTPUT" | grep -q "args=--some-arg" || { echo "FAIL: args not forwarded"; echo "$OUTPUT" >&2; exit 1; }

# Also verify through a symlink, mirroring scripts/get-zero.sh.
mkdir -p "$WORK/bin"
ln -s "$RELOCATED/bin/zero" "$WORK/bin/zero"
SYMLINK_OUTPUT="$("$WORK/bin/zero")"
echo "$SYMLINK_OUTPUT" | grep -q "ZERO_WEB_DIST=$RELOCATED/web-dist" || { echo "FAIL: symlinked invocation resolved wrong root"; echo "$SYMLINK_OUTPUT" >&2; exit 1; }

echo "OK: scripts/package-cli.sh smoke test passed"
