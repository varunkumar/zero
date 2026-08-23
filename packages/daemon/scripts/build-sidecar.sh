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
# pty-worker.js is ESM (`import ... from "node-pty"`). In-repo that's covered
# by packages/daemon/package.json's "type": "module", but nothing carries
# that setting into node-runtime/ once relocated - without this, Node falls
# back to module-syntax auto-detection, which only works on Node >= 22.7 and
# fails silently (in the shipped app, not in any test here) on older Node.
echo '{"type":"module"}' > "$OUT_DIR/node-runtime/package.json"

echo "Bundling web UI (packages/web/dist)..."
WEB_DIST="$REPO_ROOT/packages/web/dist"
if [ ! -d "$WEB_DIST" ]; then
  echo "error: $WEB_DIST does not exist - run 'bun run --cwd packages/web build' first" >&2
  exit 1
fi
# import.meta.url-relative resolution (bin/zero.ts's default webDist) breaks
# inside a `bun build --compile` binary the same way it did for pty-worker.js
# (see ZERO_WEB_DIST in bin/zero.ts) - bundle a real, relocatable copy here
# so the Tauri shell can point the sidecar at it via that env var.
cp -RL "$WEB_DIST" "$OUT_DIR/web-dist"

# Same import.meta.url-relative resolution problem for the daemon's own
# plugins/ dir, which holds each plugin's optional ui/dist/index.js bundle
# (served at GET /plugins/:id/ui.js). Lay the copies out as
# <pluginsDir>/<id>/ui/dist/index.js so the Tauri shell can point
# ZERO_PLUGINS_DIR at this directory with no server-side changes.
echo "Building and bundling plugin UI bundles..."
bun run --cwd "$DAEMON_DIR" build:plugin-ui
mkdir -p "$OUT_DIR/plugins-ui"
for plugin_ui_dist in "$DAEMON_DIR"/src/plugins/*/ui/dist; do
  [ -d "$plugin_ui_dist" ] || continue
  plugin_id="$(basename "$(dirname "$(dirname "$plugin_ui_dist")")")"
  mkdir -p "$OUT_DIR/plugins-ui/$plugin_id/ui"
  cp -RL "$plugin_ui_dist" "$OUT_DIR/plugins-ui/$plugin_id/ui/dist"
done

echo "Sidecar build complete: $OUT_DIR"
