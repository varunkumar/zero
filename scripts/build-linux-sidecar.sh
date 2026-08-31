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
