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

echo "OK: scripts/get-zero.sh smoke test passed"
