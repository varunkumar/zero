# Cross-Platform CLI Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `zero` CLI/daemon (which is what "Zero", "Zero Agents",
and "Zero Claude Plugin" all run on) a real prebuilt installable for macOS
(arm64) and Linux (x64, arm64), matching the polish Zero IDE's `.dmg` and
the VS Code extension's `.vsix` already have.

**Architecture:** Reuse `packages/daemon/scripts/build-sidecar.sh` (already
solves "compile the daemon into a relocatable artifact" for Zero IDE) as
the build step; add a packaging script that turns its output into a
tarball with a small shell wrapper standing in for what
`packages/desktop/src-tauri/src/sidecar.rs` does at runtime; add a Docker
build path for the two Linux architectures (node-pty's native addon can't
be cross-compiled from macOS); add a `curl | sh` installer; wire all of it
into the existing manual `scripts/release.sh`.

**Tech Stack:** Bash (POSIX `sh` for the installer, which runs on a bare
`curl | sh` with no bash guarantee), Docker + buildx/QEMU, Bun.

**Spec:** `docs/superpowers/specs/2026-08-31-cli-packaging-design.md`

## Global Constraints

- Runtime floor: Bun >= 1.1 (project-wide, from `CLAUDE.md`).
- No CI is being introduced by this change - all builds stay manual/local
  (per spec, "Non-goals").
- Windows is out of scope (per spec, "Non-goals").
- `typescript-language-server`/`pyright-langserver` are **not** bundled -
  this is a known, pre-existing, explicitly out-of-scope gap shared with
  Zero IDE (per spec, "Known limitation").
- CLI tarball naming: `zero-<version>-<os>-<arch>.tar.gz` where
  `os` ∈ `{darwin, linux}`, `arch` ∈ `{arm64, x64}`, `version` is the bare
  `X.Y.Z` (no `v` prefix) matching root `package.json`.
- The four env vars a packaged `zero` needs are exactly:
  `ZERO_PTY_NODE_BIN`, `ZERO_PTY_WORKER_DIR`, `ZERO_WEB_DIST`,
  `ZERO_PLUGINS_DIR` (per spec section 1 - these already exist and are
  read by `packages/daemon/src/pty.ts` and `packages/daemon/bin/zero.ts`;
  no daemon/core code changes are needed anywhere in this plan).

---

## Task 1: `scripts/package-cli.sh` - tarball packaging

**Files:**
- Create: `scripts/package-cli.sh`
- Create: `scripts/package-cli.test.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `scripts/package-cli.sh <os> <arch> <version> <dist-dir> [out-dir]`
  - `os`: `darwin` | `linux`
  - `arch`: `arm64` | `x64`
  - `version`: `X.Y.Z`
  - `dist-dir`: a `packages/daemon/scripts/build-sidecar.sh` output
    directory (must contain `zero-daemon-sidecar`, `node-runtime/`,
    `web-dist/`, `plugins-ui/`)
  - `out-dir` (optional): defaults to `<repo-root>/dist-packages`
  - Writes `<out-dir>/zero-<version>-<os>-<arch>.tar.gz` and prints its
    path on success.
  - The tarball's `bin/zero` wrapper sets `ZERO_PTY_NODE_BIN`,
    `ZERO_PTY_WORKER_DIR`, `ZERO_WEB_DIST`, `ZERO_PLUGINS_DIR` relative to
    its own resolved location (following symlinks) and execs
    `zero-daemon-sidecar`.
- Consumes: nothing from other tasks (this task is buildable and testable
  standalone, with a fake `dist-dir`).

- [ ] **Step 1: Write the test script (expected to fail - `package-cli.sh` doesn't exist yet)**

Create `scripts/package-cli.test.sh`:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
chmod +x scripts/package-cli.test.sh
./scripts/package-cli.test.sh
```

Expected: fails with something like `scripts/package-cli.sh: No such file
or directory` (the script doesn't exist yet).

- [ ] **Step 3: Write `scripts/package-cli.sh`**

```bash
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

cat > "$PKG_DIR/bin/zero" <<'WRAPPER'
#!/bin/sh
# Wrapper for the compiled zero-daemon-sidecar binary: points it at the
# node-runtime/web-dist/plugins-ui bundled alongside it in this package -
# the same job packages/desktop/src-tauri/src/sidecar.rs does for Zero
# IDE. Resolves symlinks manually (not `readlink -f`, which macOS's BSD
# readlink doesn't support) since scripts/get-zero.sh installs this via a
# symlink in ~/.local/bin.
set -eu
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
WRAPPER
chmod +x "$PKG_DIR/bin/zero"
chmod +x "$PKG_DIR/zero-daemon-sidecar"

mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/$PKG_NAME.tar.gz"
tar -C "$WORK_DIR" -czf "$TARBALL" "$PKG_NAME"

echo "Packaged: $TARBALL"
```

- [ ] **Step 4: Make both scripts executable and run the test again**

```bash
chmod +x scripts/package-cli.sh
./scripts/package-cli.test.sh
```

Expected: `OK: scripts/package-cli.sh smoke test passed`

- [ ] **Step 5: Ignore the packaging output directory**

Add to `.gitignore` (append to the existing file):

```
dist-packages/
```

- [ ] **Step 6: Commit**

```bash
git add scripts/package-cli.sh scripts/package-cli.test.sh .gitignore
git commit -m "feat(release): add scripts/package-cli.sh for CLI tarball packaging"
```

---

## Task 2: Linux Docker build path

**Files:**
- Create: `docker/linux-build.Dockerfile`
- Create: `.dockerignore`
- Create: `scripts/build-linux-sidecar.sh`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `scripts/build-linux-sidecar.sh <x64|arm64>` - builds
  `packages/daemon/dist-linux-<arch>/`, a `build-sidecar.sh`-shaped
  output directory (same 4 entries: `zero-daemon-sidecar`,
  `node-runtime/`, `web-dist/`, `plugins-ui/`), suitable as the
  `<dist-dir>` argument to `scripts/package-cli.sh` (Task 1).
- Consumes: nothing from other tasks. Requires Docker with buildx on the
  machine running it (checked explicitly).

- [ ] **Step 1: Write `.dockerignore`**

Create `.dockerignore` at repo root (keeps the build context small - this
repo has `packages/desktop/src-tauri/target/` and `node_modules/` which
are large and irrelevant/wrong-arch for the Linux build):

```
node_modules
**/node_modules
dist
**/dist
dist-packages
packages/daemon/dist-linux-x64
packages/daemon/dist-linux-arm64
packages/desktop/src-tauri/target
.git
.zero
graphify-out
*.tsbuildinfo
.DS_Store
```

- [ ] **Step 2: Write `docker/linux-build.Dockerfile`**

```dockerfile
# Builds packages/daemon's standalone sidecar (see
# packages/daemon/scripts/build-sidecar.sh) natively inside a container
# matching the target Linux architecture. node-pty's native addon and the
# bundled `node` binary are platform/arch-specific, so this must run on a
# real (or QEMU-emulated) container of that architecture, not be
# cross-compiled from macOS - see
# docs/superpowers/specs/2026-08-31-cli-packaging-design.md section 2.
FROM node:20-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /repo
COPY . .

RUN bun install
RUN bun run --cwd packages/web build
RUN bun run --cwd packages/daemon build:sidecar
```

- [ ] **Step 3: Write `scripts/build-linux-sidecar.sh`**

```bash
#!/usr/bin/env bash
# Builds the Linux daemon sidecar (packages/daemon/scripts/build-sidecar.sh)
# for a given architecture inside a Docker container of that architecture,
# via buildx/QEMU. See
# docs/superpowers/specs/2026-08-31-cli-packaging-design.md section 2 for
# why this can't be cross-compiled from macOS directly.
set -euo pipefail

if [ $# -ne 1 ] || { [ "$1" != "x64" ] && [ "$1" != "arm64" ]; }; then
  echo "usage: $0 <x64|arm64>" >&2
  exit 1
fi
ARCH="$1"
if [ "$ARCH" = "x64" ]; then
  PLATFORM="linux/amd64"
else
  PLATFORM="linux/arm64"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker is required but wasn't found on PATH" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="zero-linux-sidecar-build:$ARCH"

echo "==> Building $PLATFORM sidecar image (native builds are fast; emulated cross-arch builds under QEMU can take tens of minutes - this compiles node-pty's native addon from source)"
docker buildx build --platform "$PLATFORM" -f "$REPO_ROOT/docker/linux-build.Dockerfile" -t "$IMAGE" --load "$REPO_ROOT"

CONTAINER="$(docker create --platform "$PLATFORM" "$IMAGE")"
trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

OUT_DIR="$REPO_ROOT/packages/daemon/dist-linux-$ARCH"
rm -rf "$OUT_DIR"
docker cp "$CONTAINER:/repo/packages/daemon/dist" "$OUT_DIR"

echo "==> Linux/$ARCH sidecar build complete: $OUT_DIR"
```

- [ ] **Step 4: Make the script executable and syntax-check both scripts**

```bash
chmod +x scripts/build-linux-sidecar.sh
bash -n scripts/build-linux-sidecar.sh
```

Expected: no output, exit code 0. A full functional test requires a
working Docker daemon with buildx and is **not** automatable in this
task - per the spec's Testing section, exercise it manually at least once
per architecture before relying on it in a real release:

```bash
./scripts/build-linux-sidecar.sh x64
ls packages/daemon/dist-linux-x64   # expect: zero-daemon-sidecar node-runtime plugins-ui web-dist
./scripts/build-linux-sidecar.sh arm64
ls packages/daemon/dist-linux-arm64
```

- [ ] **Step 5: Ignore the Linux dist output directories**

Add to `.gitignore` (append):

```
packages/daemon/dist-linux-x64/
packages/daemon/dist-linux-arm64/
```

- [ ] **Step 6: Commit**

```bash
git add docker/linux-build.Dockerfile .dockerignore scripts/build-linux-sidecar.sh .gitignore
git commit -m "feat(release): add Docker-based Linux sidecar build"
```

---

## Task 3: `scripts/get-zero.sh` - install script

**Files:**
- Create: `scripts/get-zero.sh`
- Create: `scripts/get-zero.test.sh`

**Interfaces:**
- Produces: `scripts/get-zero.sh` - a POSIX `sh` script (must run under a
  bare `sh`, not assume bash, since it's fetched via `curl | sh`). Reads
  optional env overrides for testability: `GET_ZERO_REPO` (default
  `varunkumar/zero`), `GET_ZERO_API_BASE` (default
  `https://api.github.com/repos/$GET_ZERO_REPO`), `GET_ZERO_HOME`
  (default `$HOME`), `GET_ZERO_PLATFORM` (default: detected from `uname
  -s`/`uname -m`). On success, symlinks `$GET_ZERO_HOME/.local/bin/zero`
  to the extracted `bin/zero` inside
  `$GET_ZERO_HOME/.local/share/zero/<version>/`.
- Consumes: a GitHub Releases API response shaped like
  `GET $GET_ZERO_API_BASE/releases/latest` (real GitHub API shape:
  `{"tag_name": "...", "assets": [{"name": "...", "browser_download_url": "..."}]}`)
  and an asset tarball shaped like `scripts/package-cli.sh`'s output
  (Task 1) - `<pkg-name>/bin/zero` at the tarball root.

- [ ] **Step 1: Write the test script (expected to fail - `get-zero.sh` doesn't exist yet)**

Create `scripts/get-zero.test.sh`:

```bash
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
chmod +x scripts/get-zero.test.sh
./scripts/get-zero.test.sh
```

Expected: fails - `sh: scripts/get-zero.sh: No such file or directory` (or
similar; the script doesn't exist yet).

- [ ] **Step 3: Write `scripts/get-zero.sh`**

```sh
#!/bin/sh
# Installs the zero CLI (Zero / Zero Agents / Zero Claude Plugin) from a
# prebuilt GitHub release tarball - no Bun or repo checkout required.
#
#   curl -fsSL https://raw.githubusercontent.com/varunkumar/zero/main/scripts/get-zero.sh | sh
#
# See docs/superpowers/specs/2026-08-31-cli-packaging-design.md section 5.
set -eu

REPO="${GET_ZERO_REPO:-varunkumar/zero}"
API_BASE="${GET_ZERO_API_BASE:-https://api.github.com/repos/$REPO}"
HOME_DIR="${GET_ZERO_HOME:-$HOME}"
INSTALL_ROOT="$HOME_DIR/.local/share/zero"
BIN_DIR="$HOME_DIR/.local/bin"

if [ -n "${GET_ZERO_PLATFORM:-}" ]; then
  PLATFORM="$GET_ZERO_PLATFORM"
else
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) platform_os="darwin" ;;
    Linux) platform_os="linux" ;;
    *) echo "error: unsupported OS: $os (zero prebuilt binaries cover macOS and Linux)" >&2; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) platform_arch="arm64" ;;
    x86_64|amd64) platform_arch="x64" ;;
    *) echo "error: unsupported architecture: $arch" >&2; exit 1 ;;
  esac
  if [ "$platform_os" = "darwin" ] && [ "$platform_arch" = "x64" ]; then
    echo "error: macOS x64 (Intel) isn't built yet - only macOS arm64 (Apple Silicon) and Linux x64/arm64 are available" >&2
    exit 1
  fi
  PLATFORM="$platform_os-$platform_arch"
fi

echo "Fetching latest release info..."
RELEASE_JSON="$(curl -fsSL "$API_BASE/releases/latest")"

TAG="$(printf '%s' "$RELEASE_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
if [ -z "$TAG" ]; then
  echo "error: couldn't determine the latest release tag from $API_BASE/releases/latest" >&2
  exit 1
fi
VERSION="$(printf '%s' "$TAG" | sed -E 's/^v//')"

ASSET_NAME="zero-$VERSION-$PLATFORM.tar.gz"
DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*$ASSET_NAME\"" | sed -E 's/.*"(https?:[^"]+)"/\1/')"
if [ -z "$DOWNLOAD_URL" ]; then
  echo "error: no $ASSET_NAME asset found on release $TAG" >&2
  exit 1
fi

VERSION_DIR="$INSTALL_ROOT/$VERSION"
if [ -d "$VERSION_DIR" ]; then
  echo "zero $VERSION already installed at $VERSION_DIR - reinstalling"
  rm -rf "$VERSION_DIR"
fi
mkdir -p "$VERSION_DIR"

TMP_TAR="$(mktemp)"
trap 'rm -f "$TMP_TAR"' EXIT
echo "Downloading $ASSET_NAME..."
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_TAR"

echo "Installing to $VERSION_DIR..."
tar -C "$VERSION_DIR" --strip-components=1 -xzf "$TMP_TAR"

mkdir -p "$BIN_DIR"
LINK="$BIN_DIR/zero"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "error: $LINK exists and isn't a symlink - remove it, or set GET_ZERO_HOME to install elsewhere" >&2
  exit 1
fi
ln -sf "$VERSION_DIR/bin/zero" "$LINK"

echo "Installed zero $VERSION -> $LINK"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add this to your shell rc file:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
```

- [ ] **Step 4: Make both scripts executable and run the test again**

```bash
chmod +x scripts/get-zero.sh
./scripts/get-zero.test.sh
```

Expected: `OK: scripts/get-zero.sh smoke test passed`

- [ ] **Step 5: Commit**

```bash
git add scripts/get-zero.sh scripts/get-zero.test.sh
git commit -m "feat(release): add scripts/get-zero.sh curl-installer for the zero CLI"
```

---

## Task 4: Wire packaging into `scripts/release.sh`

**Files:**
- Modify: `scripts/release.sh`

**Interfaces:**
- Consumes: `scripts/package-cli.sh` (Task 1), `scripts/build-linux-sidecar.sh`
  (Task 2) - exact CLI signatures as documented in those tasks' Interfaces
  blocks.
- Produces: three additional release assets uploaded by `gh release
  create`: `dist-packages/zero-$VERSION-darwin-arm64.tar.gz`,
  `dist-packages/zero-$VERSION-linux-x64.tar.gz`,
  `dist-packages/zero-$VERSION-linux-arm64.tar.gz`.

- [ ] **Step 1: Require `docker` alongside the existing tool checks**

In `scripts/release.sh`, find:

```bash
for cmd in bun cargo gh; do
```

Replace with:

```bash
for cmd in bun cargo gh docker; do
```

- [ ] **Step 2: Add the CLI packaging steps after the VS Code `.vsix` build**

Find this existing block:

```bash
echo "==> Building the VS Code extension .vsix"
(cd packages/vscode && bun run package)
VSIX="packages/vscode/zero-vscode-$VERSION.vsix"
if [ ! -f "$VSIX" ]; then
  echo "error: expected $VSIX after vsce package, not found" >&2
  exit 1
fi
```

Insert immediately after it:

```bash
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
```

- [ ] **Step 3: Add the CLI install instructions to the release notes**

Find this existing block:

```bash
- **Zero VS Code extension** - \`zero-vscode-${VERSION}.vsix\`. Install with:
  \`\`\`
  code --install-extension zero-vscode-${VERSION}.vsix
  \`\`\`

See [\`docs/releasing.md\`](https://github.com/varunkumar/zero/blob/main/docs/releasing.md) for how this release was built.
EOF
```

Replace with:

```bash
- **Zero VS Code extension** - \`zero-vscode-${VERSION}.vsix\`. Install with:
  \`\`\`
  code --install-extension zero-vscode-${VERSION}.vsix
  \`\`\`
- **Zero / Zero Agents / Zero Claude (CLI, macOS arm64 + Linux x64/arm64)** -
  install with:
  \`\`\`
  curl -fsSL https://raw.githubusercontent.com/varunkumar/zero/main/scripts/get-zero.sh | sh
  \`\`\`

See [\`docs/releasing.md\`](https://github.com/varunkumar/zero/blob/main/docs/releasing.md) for how this release was built.
EOF
```

- [ ] **Step 4: Attach the three new tarballs to the GitHub release**

Find:

```bash
gh release create "v$VERSION" "$DMG" "$VSIX" \
  --title "Zero v$VERSION" \
  --notes-file "$NOTES"
```

Replace with:

```bash
gh release create "v$VERSION" "$DMG" "$VSIX" "$CLI_MACOS" "$CLI_LINUX_X64" "$CLI_LINUX_ARM64" \
  --title "Zero v$VERSION" \
  --notes-file "$NOTES"
```

- [ ] **Step 5: Syntax-check the script**

```bash
bash -n scripts/release.sh
```

Expected: no output, exit code 0. (Running `scripts/release.sh` for real
requires a clean `main`, a version bump, and a real GitHub release, so
it's not run end-to-end as part of this task - Tasks 1-3's own tests
already cover `package-cli.sh`/`get-zero.sh` correctness in isolation,
and Task 2's manual verification covers the Docker build.)

- [ ] **Step 6: Commit**

```bash
git add scripts/release.sh
git commit -m "feat(release): package and publish zero CLI tarballs from release.sh"
```

---

## Task 5: Docs

**Files:**
- Modify: `README.md`
- Modify: `docs/releasing.md`

**Interfaces:** None (docs only).

- [ ] **Step 1: Update README's CLI install section**

Find:

```markdown
### Zero, Zero Agents (CLI/daemon)

No prebuilt binary yet - build from source:

```
git clone https://github.com/varunkumar/zero.git
cd zero
./scripts/install.sh
```

This installs dependencies, builds the web UI, and puts a `zero` wrapper
script on `~/.local/bin/zero` that always runs against this checkout.
Requires [Bun](https://bun.sh) >= 1.1.
```

Replace with:

```markdown
### Zero, Zero Agents (CLI/daemon)

```
curl -fsSL https://raw.githubusercontent.com/varunkumar/zero/main/scripts/get-zero.sh | sh
```

Downloads the right prebuilt tarball for your platform (macOS arm64, or
Linux x64/arm64) from the
[latest release](https://github.com/varunkumar/zero/releases/latest) and
installs a `zero` wrapper on `~/.local/bin/zero`. No Bun and no repo
checkout required.

**Building from source instead** (for contributors, or platforms without a
prebuilt tarball yet):

```
git clone https://github.com/varunkumar/zero.git
cd zero
./scripts/install.sh
```

This installs dependencies, builds the web UI, and puts a `zero` wrapper
script on `~/.local/bin/zero` that always runs against this checkout.
Requires [Bun](https://bun.sh) >= 1.1.
```

- [ ] **Step 2: Rewrite `docs/releasing.md`'s artifact-build step**

Find:

```markdown
3. **Build the artifacts:**
   ```
   bun run --cwd packages/web build              # web UI (needed by both the sidecar and the vsix bundle indirectly)
   bun run --cwd packages/daemon build:sidecar    # daemon sidecar + portable node runtime, into packages/daemon/dist/
   (cd packages/vscode && bun run package)        # -> packages/vscode/zero-vscode-<version>.vsix
   bun run --cwd packages/desktop tauri build     # -> packages/desktop/src-tauri/target/release/bundle/{macos/Zero.app, dmg/Zero_<version>_aarch64.dmg}
   ```
```

Replace with:

```markdown
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

   The two Linux builds run inside Docker containers of the matching
   architecture (`docker/linux-build.Dockerfile`), since node-pty's native
   addon and the bundled `node` binary are architecture-specific and can't
   be cross-compiled from macOS. `linux/arm64` runs natively under Docker
   Desktop's VM on an Apple Silicon machine; `linux/amd64` runs under QEMU
   emulation and is the slow step in a release - budget tens of minutes
   for it.
```

- [ ] **Step 3: Update the publish step's file list**

Find:

```markdown
5. **Publish the release:**
   ```
   gh release create v<version> \
     packages/desktop/src-tauri/target/release/bundle/dmg/Zero_<version>_aarch64.dmg \
     packages/vscode/zero-vscode-<version>.vsix \
     --title "Zero v<version>" \
     --notes "..."
   ```
```

Replace with:

```markdown
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
```

- [ ] **Step 4: Rewrite the "Platform scope" section**

Find:

```markdown
## Platform scope

Builds today are macOS (Apple Silicon) only, matching Zero IDE's current
scope. Cross-platform packaging is a deferred follow-up, not something this
process handles yet.
```

Replace with:

```markdown
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
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/releasing.md
git commit -m "docs: document the zero CLI curl installer and release process"
```

---

## Post-plan verification

After all five tasks are done, run the full test suite one more time to
confirm nothing else broke:

```bash
bun test
bun run typecheck
./scripts/package-cli.test.sh
./scripts/get-zero.test.sh
bash -n scripts/release.sh
bash -n scripts/build-linux-sidecar.sh
```

All should pass/exit 0. A real Linux Docker build
(`./scripts/build-linux-sidecar.sh x64` and `arm64`) and a real release
dry-run are recommended before the next actual `./scripts/release.sh`
invocation, but aren't required to consider this plan complete - they're
manual verifications outside what these tasks can automate (per the
spec's Testing section).
