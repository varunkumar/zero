#!/usr/bin/env bash
# Installs the `zero` command onto PATH via a wrapper at ~/.local/bin/zero
# that always runs against this checkout (not `bun link`, so it keeps
# working regardless of the native node-pty addon's compiled location).
set -euo pipefail

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required (https://bun.sh) but wasn't found on PATH" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Installing dependencies (this also compiles node-pty's native addon)..."
(cd "$REPO_ROOT" && bun install)

echo "Building web UI (used by 'zero serve')..."
(cd "$REPO_ROOT/packages/web" && bun run build)

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

WRAPPER="$BIN_DIR/zero"
cat > "$WRAPPER" <<EOF
#!/usr/bin/env bash
exec bun run "$REPO_ROOT/packages/daemon/bin/zero.ts" "\$@"
EOF
chmod +x "$WRAPPER"

echo "Installed zero -> $WRAPPER"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add this to your shell rc file:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
