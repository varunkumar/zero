#!/usr/bin/env bash
# End-to-end smoke test for scripts/get-zero.sh against a fake local
# GitHub-API-shaped HTTP server (no real network access, no real GitHub
# release needed). Verifies the full fetch -> extract -> symlink flow.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Build a fake release asset: a package shaped like scripts/package-cli.sh's
# output, with a bin/zero stub (no real sidecar needed for this test).
PKG_DIR="$WORK/pkg/zero-9.9.9-test-platform"
mkdir -p "$PKG_DIR/bin"
cat > "$PKG_DIR/bin/zero" <<'EOF'
#!/bin/sh
echo "fake-zero-ok"
EOF
chmod +x "$PKG_DIR/bin/zero"
mkdir -p "$WORK/assets"
tar -C "$WORK/pkg" -czf "$WORK/assets/zero-9.9.9-test-platform.tar.gz" "zero-9.9.9-test-platform"

# Fake GitHub-API-shaped server: serves /releases/latest and the asset.
cat > "$WORK/server.ts" <<EOF
const assetsDir = "$WORK/assets";
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/releases/latest") {
      const body = JSON.stringify({
        tag_name: "v9.9.9",
        assets: [{
          name: "zero-9.9.9-test-platform.tar.gz",
          browser_download_url: \`\${url.origin}/download/zero-9.9.9-test-platform.tar.gz\`,
        }],
      });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/download/zero-9.9.9-test-platform.tar.gz") {
      return new Response(Bun.file(\`\${assetsDir}/zero-9.9.9-test-platform.tar.gz\`));
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(server.port);
EOF

bun run "$WORK/server.ts" > "$WORK/port.txt" 2>"$WORK/server.log" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [ -s "$WORK/port.txt" ] && break
  sleep 0.1
done
PORT="$(cat "$WORK/port.txt" 2>/dev/null || true)"
if [ -z "$PORT" ]; then
  echo "FAIL: fake server never printed a port" >&2
  cat "$WORK/server.log" >&2
  exit 1
fi

GET_ZERO_HOME="$WORK/home" \
GET_ZERO_API_BASE="http://127.0.0.1:$PORT" \
GET_ZERO_PLATFORM="test-platform" \
sh "$REPO_ROOT/scripts/get-zero.sh"

LINK="$WORK/home/.local/bin/zero"
if [ ! -L "$LINK" ]; then
  echo "FAIL: expected symlink at $LINK" >&2
  exit 1
fi
OUTPUT="$("$LINK")"
if [ "$OUTPUT" != "fake-zero-ok" ]; then
  echo "FAIL: unexpected output: $OUTPUT" >&2
  exit 1
fi

VERSION_DIR="$WORK/home/.local/share/zero/9.9.9"
if [ ! -d "$VERSION_DIR" ]; then
  echo "FAIL: expected version dir $VERSION_DIR" >&2
  exit 1
fi

echo "OK: happy path install"

# Case 2: an existing regular (non-symlink) file at $BIN_DIR/zero must make
# the script bail out without touching it.
CLOBBER_HOME="$WORK/home-clobber"
mkdir -p "$CLOBBER_HOME/.local/bin"
CLOBBER_FILE="$CLOBBER_HOME/.local/bin/zero"
echo "do-not-touch-me" > "$CLOBBER_FILE"
if GET_ZERO_HOME="$CLOBBER_HOME" \
  GET_ZERO_API_BASE="http://127.0.0.1:$PORT" \
  GET_ZERO_PLATFORM="test-platform" \
  sh "$REPO_ROOT/scripts/get-zero.sh" >/dev/null 2>"$WORK/clobber.err"; then
  echo "FAIL: expected nonzero exit when $CLOBBER_FILE is a regular file" >&2
  exit 1
fi
if [ ! -f "$CLOBBER_FILE" ] || [ -L "$CLOBBER_FILE" ]; then
  echo "FAIL: the pre-existing regular file was replaced" >&2
  exit 1
fi
if [ "$(cat "$CLOBBER_FILE")" != "do-not-touch-me" ]; then
  echo "FAIL: the pre-existing regular file's content was modified" >&2
  exit 1
fi
echo "OK: refuses to clobber a pre-existing regular file at the link path"

# Case 3: re-running over an existing install replaces the symlink silently
# (exercises the `ln -sfn` / staged-extract path).
GET_ZERO_HOME="$WORK/home" \
GET_ZERO_API_BASE="http://127.0.0.1:$PORT" \
GET_ZERO_PLATFORM="test-platform" \
sh "$REPO_ROOT/scripts/get-zero.sh"

if [ ! -L "$LINK" ]; then
  echo "FAIL: reinstall did not leave a symlink at $LINK" >&2
  exit 1
fi
REINSTALL_OUTPUT="$("$LINK")"
if [ "$REINSTALL_OUTPUT" != "fake-zero-ok" ]; then
  echo "FAIL: symlink broken after reinstall: $REINSTALL_OUTPUT" >&2
  exit 1
fi
echo "OK: reinstall over an existing symlink succeeds and still resolves"

# Case 4: no asset matching the requested platform -> clear error, nonzero exit.
if GET_ZERO_HOME="$WORK/home-noasset" \
  GET_ZERO_API_BASE="http://127.0.0.1:$PORT" \
  GET_ZERO_PLATFORM="nonexistent-platform" \
  sh "$REPO_ROOT/scripts/get-zero.sh" >/dev/null 2>"$WORK/noasset.err"; then
  echo "FAIL: expected nonzero exit for an unmatched platform" >&2
  exit 1
fi
if ! grep -q "zero-9.9.9-nonexistent-platform.tar.gz" "$WORK/noasset.err"; then
  echo "FAIL: expected a missing-asset error, got:" >&2
  cat "$WORK/noasset.err" >&2
  exit 1
fi
if [ -d "$WORK/home-noasset/.local/share/zero/9.9.9" ]; then
  echo "FAIL: an install dir was created despite the missing asset" >&2
  exit 1
fi
echo "OK: errors out when no asset matches the platform"

echo "OK: scripts/get-zero.sh smoke test passed"
