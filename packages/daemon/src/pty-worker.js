import * as pty from "node-pty";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { existsSync, statSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

const sessions = new Map();

// Root cause (see packages/daemon/src/pty.test.ts and task-3-report.md):
// package managers (bun in particular, reproduced directly in this repo)
// extract node-pty's prebuilt native helper binary ("spawn-helper" on
// macOS/Linux) without the executable bit set. node-pty's own loader never
// checks this - it just shells out via posix_spawnp, which fails
// synchronously with "posix_spawnp failed" for every single session, every
// time, until something restores +x. From the daemon's side this looks
// exactly like "the terminal panel doesn't load": pty.spawn() throws, the
// existing catch below reports an immediate exit, and no shell ever comes
// up. This is a filesystem-permission bug, not a startup race or a
// node-vs-bun PTY incompatibility (that concern is about node-pty's
// native binding not delivering onData under Bun's runtime - it's the
// reason this whole worker is hosted under real `node` in the first
// place; it does not explain this failure).
//
// Fix: proactively restore +x on node-pty's native helper binary before
// ever calling pty.spawn(), using the same search order node-pty's own
// lib/utils.js#loadNativeModule uses to locate its .node binding (build/
// Release, build/Debug, prebuilds/<platform>-<arch>, each tried relative
// to both the package root and lib/). Entirely best-effort: any failure
// here (read-only fs, missing package, Windows where there is no
// spawn-helper binary) is swallowed so the worker still starts and still
// degrades gracefully via the existing open()/catch path below.
function ensureNativeHelperExecutable() {
  if (process.platform === "win32") return; // no spawn-helper on Windows (conpty)
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve("node-pty/package.json"));
    const dirs = ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`];
    const roots = [pkgDir, join(pkgDir, "lib")];
    for (const d of dirs) {
      for (const root of roots) {
        const candidateDir = join(root, d);
        const helperPath = join(candidateDir, "spawn-helper");
        if (!existsSync(helperPath)) continue;
        const mode = statSync(helperPath).mode;
        const isExecutable = (mode & 0o111) !== 0;
        if (!isExecutable) chmodSync(helperPath, 0o755);
      }
    }
  } catch {
    // Best-effort self-heal only - never let this take the worker down.
  }
}

ensureNativeHelperExecutable();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function spawnSession(msg) {
  const proc = pty.spawn(msg.shell, [], {
    name: "xterm-256color", cols: msg.cols, rows: msg.rows, cwd: msg.cwd,
    env: process.env,
  });
  sessions.set(msg.sessionId, proc);
  proc.onData((data) => {
    if (!sessions.has(msg.sessionId)) return;
    send({ event: "data", sessionId: msg.sessionId, data });
  });
  proc.onExit(({ exitCode }) => {
    if (!sessions.has(msg.sessionId)) return;
    sessions.delete(msg.sessionId);
    send({ event: "exit", sessionId: msg.sessionId, exitCode });
  });
}

function handle(msg) {
  if (msg.type === "open") {
    try {
      spawnSession(msg);
    } catch (err) {
      // node-pty throws synchronously for e.g. a nonexistent shell binary,
      // or (see ensureNativeHelperExecutable above) a spawn-helper binary
      // that lost its executable bit during package install. The latter is
      // recoverable: re-run the self-heal and retry exactly once before
      // giving up, in case permissions changed after this worker started
      // (e.g. a package reinstall completed mid-run).
      const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
      if (/posix_spawnp failed/i.test(message) && !sessions.has(msg.sessionId)) {
        ensureNativeHelperExecutable();
        try {
          spawnSession(msg);
          return;
        } catch {
          // fall through to the failure report below
        }
      }
      // There is no live session to have been added to `sessions` here (the
      // throw happens before pty.spawn returns), so nothing to remove — just
      // report the failure so the parent's #sessions entry gets cleaned up
      // instead of pointing at a session that never came up.
      send({ event: "exit", sessionId: msg.sessionId, exitCode: 1 });
    }
    return;
  }
  if (msg.type === "input") { sessions.get(msg.sessionId)?.write(msg.data); return; }
  if (msg.type === "resize") { sessions.get(msg.sessionId)?.resize(msg.cols, msg.rows); return; }
  if (msg.type === "close") {
    const proc = sessions.get(msg.sessionId);
    if (!proc) return;
    sessions.delete(msg.sessionId);
    proc.kill();
    return;
  }
  if (msg.type === "closeAll") {
    for (const proc of sessions.values()) proc.kill();
    sessions.clear();
    return;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  try {
    handle(msg);
  } catch {
    // Defensive: handle() should not throw beyond the try/catch already
    // inside the "open" branch, but never let any other message type's
    // failure take the whole worker (and every live session with it) down.
  }
});

// If the parent daemon dies (or its stdin pipe otherwise closes) without
// calling closeAll(), don't leave this worker (and every real shell process
// it's hosting via node-pty) running as an orphan forever. On Unix a child
// is reparented rather than killed when its parent exits, so without this
// the worker's event loop — kept alive by the live node-pty sessions — would
// never exit on its own.
rl.on("close", () => {
  for (const proc of sessions.values()) proc.kill();
  process.exit(0);
});
