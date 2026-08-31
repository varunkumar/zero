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
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: couldn't parse a valid version from release tag '$TAG'" >&2
  exit 1
fi

ASSET_NAME="zero-$VERSION-$PLATFORM.tar.gz"
DOWNLOAD_URL="$(printf '%s' "$RELEASE_JSON" | grep -o "\"browser_download_url\": *\"[^\"]*$ASSET_NAME\"" | sed -E 's/.*"(https?:[^"]+)"/\1/')"
if [ -z "$DOWNLOAD_URL" ]; then
  echo "error: no $ASSET_NAME asset found on release $TAG" >&2
  exit 1
fi

VERSION_DIR="$INSTALL_ROOT/$VERSION"
STAGING_DIR="$INSTALL_ROOT/.zero-install-$VERSION.$$"
TMP_TAR="$(mktemp)"
trap 'rm -f "$TMP_TAR"; rm -rf "$STAGING_DIR"' EXIT

echo "Downloading $ASSET_NAME..."
curl -fsSL "$DOWNLOAD_URL" -o "$TMP_TAR"

mkdir -p "$STAGING_DIR"
echo "Installing to $VERSION_DIR..."
tar -C "$STAGING_DIR" --strip-components=1 -xzf "$TMP_TAR"
rm -rf "$VERSION_DIR"
mv "$STAGING_DIR" "$VERSION_DIR"

mkdir -p "$BIN_DIR"
LINK="$BIN_DIR/zero"
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  echo "error: $LINK exists and isn't a symlink - remove it, or set GET_ZERO_HOME to install elsewhere" >&2
  exit 1
fi
ln -sfn "$VERSION_DIR/bin/zero" "$LINK"

echo "Installed zero $VERSION -> $LINK"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add this to your shell rc file:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
