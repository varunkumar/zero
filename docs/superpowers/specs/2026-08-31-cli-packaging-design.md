# Cross-platform CLI packaging for Zero / Zero Agents / Zero Claude

## Problem

Zero IDE (`packages/desktop`) ships as a signed-enough `.dmg` and the VS
Code extension ships as a `.vsix`, both attached to GitHub releases by
`scripts/release.sh`. The `zero` CLI/daemon - which is what "Zero" (`zero
serve`), "Zero Agents" (`zero`, `zero -p`), and "Zero Claude Plugin" (`zero
claude`) all actually are - has no installable artifact. The README tells
users to `git clone` the repo and run `scripts/install.sh`, which requires
Bun on the machine and a full source checkout.

`docs/releasing.md` already flags this: "Builds today are macOS (Apple
Silicon) only... Cross-platform packaging is a deferred follow-up." This
spec is that follow-up, scoped to the CLI/daemon only (Zero IDE and the VS
Code extension are unaffected).

## Goals

- A downloadable, prebuilt `zero` CLI for macOS (arm64) and Linux (x64,
  arm64), installable without cloning the repo or having Bun on the
  machine.
- A one-line install experience matching the polish of `brew install` /
  `curl | sh` installers users already expect.
- Reuse the existing sidecar-build machinery (`build-sidecar.sh`) rather
  than inventing a second bundling strategy.
- Keep releases fully manual/local, consistent with how `scripts/release.sh`
  already works today (no CI in this repo yet, and none is being added by
  this change).

## Non-goals

- Windows support.
- Fixing `typescript-language-server`/`pyright-langserver` not being
  bundled (they're resolved via `PATH` today - see "Known limitation"
  below). This is a pre-existing gap shared with Zero IDE, not something
  this change addresses.
- A Homebrew tap, apt/deb packages, or npm-global distribution. The
  tarball + curl installer is the whole distribution mechanism for now.
- Code-signing/notarizing the Linux or macOS CLI binaries.

## Design

### 1. Reusing the sidecar build

`packages/daemon/scripts/build-sidecar.sh` already produces everything a
standalone `zero` needs, because Zero IDE's Tauri shell has the exact same
problem (a compiled `bun build --compile` binary can't embed node-pty's
real-`node`-hosted PTY worker, and `import.meta.url`-relative paths break
inside a compiled binary):

- `zero-daemon-sidecar` - the compiled daemon binary
- `node-runtime/` - a portable `node` + `node_modules/node-pty` +
  `pty-worker.js`
- `web-dist/` - the built web UI
- `plugins-ui/` - built plugin UI bundles

`packages/desktop/src-tauri/src/sidecar.rs` currently launches this bundle
by setting four environment variables that `@zero/daemon` already reads
(`packages/daemon/src/pty.ts`, `packages/daemon/bin/zero.ts`):

```
ZERO_PTY_NODE_BIN=<node-runtime>/node
ZERO_PTY_WORKER_DIR=<node-runtime>
ZERO_WEB_DIST=<web-dist>
ZERO_PLUGINS_DIR=<plugins-ui>
```

A CLI tarball needs no new runtime code - just a shell wrapper that sets
these same four variables relative to its own location and execs the
sidecar binary, the same job `sidecar.rs` does for Zero IDE.

`build-sidecar.sh` itself needs no changes: it already builds for whatever
platform/arch it's run on. What's new is *where* it gets run for
non-macOS-arm64 targets (see below) and a packaging step on top of its
output.

### 2. Build matrix

| OS | Arch | How it's built |
|---|---|---|
| macOS | arm64 | Natively on the release machine, as today |
| Linux | x64 | `docker buildx build --platform linux/amd64` |
| Linux | arm64 | `docker buildx build --platform linux/arm64` |

node-pty's native addon and the bundled `node` binary are
platform/arch-specific, so each Linux target must actually compile inside
a container of that architecture - there is no cross-compiling this from
one Mac. On an Apple Silicon dev machine, `linux/arm64` runs natively under
Docker Desktop's VM and `linux/amd64` runs under QEMU emulation (slow -
tens of minutes is expected for `bun install`'s native build step - but
this is a release-time cost, not a dev-loop cost).

A new `docker/linux-build.Dockerfile`:

- Base: a Node LTS image (so a real, arch-matching `node` binary is
  available to bundle) with Bun installed via `curl -fsSL
  https://bun.sh/install | bash`, plus a C/C++ toolchain and Python
  (node-pty's native addon needs to build from source when no prebuilt
  binary matches the container's libc/arch).
- Runs, against a bind-mounted repo checkout: `bun install`, `bun run
  --cwd packages/web build`, `bun run --cwd packages/daemon
  build:sidecar`.
- Output (`packages/daemon/dist/`) is written to a bind-mounted host
  directory (`packages/daemon/dist-linux-<arch>/`) so it survives the
  container.

### 3. Packaging: `scripts/package-cli.sh`

New script: `scripts/package-cli.sh <os> <arch> <version> <dist-dir>`.
Takes any of the three dist directories (mac native or one of the two
Linux docker outputs) and produces `zero-<version>-<os>-<arch>.tar.gz`
with this layout:

```
zero-<version>-<os>-<arch>/
  bin/zero              # wrapper script (see below)
  zero-daemon-sidecar
  node-runtime/
  web-dist/
  plugins-ui/
```

`bin/zero` resolves its own real path (following symlinks, since the
installer will symlink into `~/.local/bin`), derives the package root as
one directory up, and execs:

```sh
ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
export ZERO_PTY_NODE_BIN="$ROOT/node-runtime/node"
export ZERO_PTY_WORKER_DIR="$ROOT/node-runtime"
export ZERO_WEB_DIST="$ROOT/web-dist"
export ZERO_PLUGINS_DIR="$ROOT/plugins-ui"
exec "$ROOT/zero-daemon-sidecar" "$@"
```

### 4. Release process changes

`scripts/release.sh` gains a step after the existing sidecar build:

1. Package the already-built macOS dist via `package-cli.sh` (no extra
   build - reuses the sidecar build the script already does for Zero IDE).
2. Run the two Docker builds, then `package-cli.sh` each output.
3. Upload all three CLI tarballs to the same `gh release create` call as
   the `.dmg` and `.vsix`.

This makes releases noticeably slower (the QEMU-emulated amd64 build is
the long pole) but keeps the existing fully-manual, single-machine release
model - no CI is introduced by this change.

### 5. Install UX: `scripts/get-zero.sh`

A new script, fetched via a stable raw-GitHub-content URL:

```
curl -fsSL https://raw.githubusercontent.com/varunkumar/zero/main/scripts/get-zero.sh | sh
```

Behavior:

1. Detect OS/arch via `uname -s` / `uname -m`, map to one of
   `darwin-arm64`, `linux-x64`, `linux-arm64`; anything else exits with a
   clear "not supported yet" error.
2. Query the GitHub Releases API for the latest release tag.
3. Download the matching `zero-<version>-<os>-<arch>.tar.gz`.
4. Extract to `~/.local/share/zero/<version>/`.
5. Symlink `~/.local/bin/zero` -> the extracted `bin/zero`, replacing any
   existing symlink there (but refusing to clobber a regular file, to
   avoid stomping on an unrelated `zero` binary a user might have).
6. Print a PATH reminder if `~/.local/bin` isn't already on `PATH`
   (matching `scripts/install.sh`'s existing behavior).

`scripts/install.sh` (build-from-source) is unchanged and stays documented
as the path for contributors/dev builds.

### 6. Docs

- README: "Zero, Zero Agents" and "Zero Claude Plugin" sections switch
  from "clone + `scripts/install.sh`" to the `curl | sh` one-liner as the
  primary path; keep a "building from source" note pointing at
  `scripts/install.sh` for contributors.
- `docs/releasing.md`: rewrite "Platform scope" to describe the new
  matrix, the Docker/QEMU build-time cost, and add the new scripts
  (`package-cli.sh`, `get-zero.sh`, `docker/linux-build.Dockerfile`) to the
  "what the script automates" walkthrough.

## Known limitation: LSP binaries aren't bundled

`packages/daemon/src/lsp/registry.ts` spawns `typescript-language-server`
and `pyright-langserver` by bare command name, resolved via `PATH`. Neither
is bundled into the sidecar for Zero IDE today, and this change doesn't
bundle them for the CLI tarball either - a packaged `zero` will start and
work (completions, terminal, chat), but LSP features degrade exactly as
they already do in Zero IDE when those binaries aren't found. Bundling
them is a separate follow-up if wanted.

## Testing

- `bin/zero` wrapper script: shell-level smoke test (extract a tarball,
  run `zero --version` from a relocated path, confirm it doesn't depend on
  the build machine's paths).
- `scripts/package-cli.sh`: verify the produced tarball's layout and that
  `bin/zero` is executable.
- Docker build: manual verification per architecture (`docker buildx build
  --platform linux/amd64|arm64 ... && package-cli.sh ... && tar -tzf ...`)
  - not something to unit test, but should be exercised at least once per
    architecture before merging.
- `scripts/get-zero.sh`: manual smoke test against a real (or draft)
  GitHub release on both a macOS arm64 machine and a Linux x64/arm64
  machine or container.

No changes to `@zero/core`, `@zero/protocol`, or `@zero/daemon`'s runtime
code are needed - this is purely build/release tooling, so it falls
outside this repo's "dense unit coverage with injected fakes" convention
for `@zero/core`.
