#!/usr/bin/env bash
# Builds the standalone daemon sidecar used by Zero IDE (packages/desktop):
# a `bun build --compile` binary plus a portable node + node-pty runtime
# dir, since the compiled binary can't embed node-pty's real-`node`-hosted
# PTY worker (see docs/superpowers/specs/2026-08-17-m8-zero-ide-design.md
# section 4.2 for why).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DAEMON_DIR="$REPO_ROOT/packages/daemon"
OUT_DIR="$DAEMON_DIR/dist"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/node-runtime/node_modules"

echo "Compiling daemon sidecar..."
bun build --compile --outfile "$OUT_DIR/zero-daemon-sidecar" "$DAEMON_DIR/bin/zero.ts"

echo "Bundling portable node + node-pty runtime..."
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "error: 'node' not found on PATH - required to bundle the PTY runtime" >&2
  exit 1
fi
cp "$NODE_BIN" "$OUT_DIR/node-runtime/node"
# -L: dereference symlinks. bun's node_modules layout stores packages under a
# shared `.bun` store and symlinks them in per-package; copying with plain
# `-R` preserves those symlinks verbatim, and their relative targets break
# once relocated to a different directory depth under dist/. -L ensures we
# copy real files so the runtime dir is actually portable/relocatable.
cp -RL "$DAEMON_DIR/node_modules/node-pty" "$OUT_DIR/node-runtime/node_modules/node-pty"
cp "$DAEMON_DIR/src/pty-worker.js" "$OUT_DIR/node-runtime/pty-worker.js"

echo "Sidecar build complete: $OUT_DIR"
