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
