import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, statSync, chmodSync } from "node:fs";
import { PtyService } from "./pty";

/**
 * Locate node-pty's native spawn-helper binary the same way node-pty's own
 * lib/utils.js#loadNativeModule (and pty-worker.js's ensureNativeHelperExecutable
 * self-heal) does: build/Release, build/Debug, then prebuilds/<platform>-<arch>,
 * each checked relative to both the package root and lib/. Returns undefined
 * on platforms with no spawn-helper binary (Windows uses conpty instead).
 */
function findSpawnHelper(): string | undefined {
  if (process.platform === "win32") return undefined;
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve("node-pty/package.json"));
  const dirs = ["build/Release", "build/Debug", `prebuilds/${process.platform}-${process.arch}`];
  const roots = [pkgDir, join(pkgDir, "lib")];
  for (const d of dirs) {
    for (const root of roots) {
      const helperPath = join(root, d, "spawn-helper");
      if (existsSync(helperPath)) return helperPath;
    }
  }
  return undefined;
}

test("open spawns a shell, input/output round-trips, close kills it", async () => {
  const output: { sessionId: string; data: string }[] = [];
  const service = new PtyService(
    process.cwd(),
    (sessionId, data) => output.push({ sessionId, data }),
    () => {},
  );

  const { sessionId, shell } = service.open("/bin/bash", 80, 24);
  expect(shell).toBe("/bin/bash");
  expect(service.list()).toEqual([{ sessionId, shell: "/bin/bash" }]);

  // The typed input line itself gets echoed back by the PTY (containing the
  // literal text we sent), so asserting on that literal text can't tell a
  // working stream apart from one that only ever fires its very first
  // onData event and then goes silent forever (the exact Bun/node-pty bug
  // this implementation exists to work around — oven-sh/bun#7362). Send a
  // command whose *output* text differs from what was typed: the input line
  // contains "abc$(echo def)", never the literal substring "abcdef" — only
  // the shell's evaluated output does.
  service.input(sessionId, "echo abc$(echo def)\n");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (output.some((o) => o.sessionId === sessionId && o.data.includes("abcdef"))) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  service.close(sessionId);
  await new Promise((r) => setTimeout(r, 100));
  expect(service.list()).toEqual([]);

  service.closeAll();
}, 10000);

test("onExit fires for a natural process exit and the session drops from list()", async () => {
  const exits: { sessionId: string; exitCode: number }[] = [];
  const service = new PtyService(
    process.cwd(),
    () => {},
    (sessionId, exitCode) => exits.push({ sessionId, exitCode }),
  );

  const { sessionId } = service.open("/bin/bash", 80, 24);
  expect(service.list()).toEqual([{ sessionId, shell: "/bin/bash" }]);

  service.input(sessionId, "exit\n");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (exits.some((e) => e.sessionId === sessionId)) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  expect(exits).toEqual([{ sessionId, exitCode: 0 }]);
  expect(service.list()).toEqual([]);

  service.closeAll();
}, 10000);

test("two concurrent sessions keep independent output streams (second terminal tab)", async () => {
  const output: { sessionId: string; data: string }[] = [];
  const service = new PtyService(process.cwd(), (sessionId, data) => output.push({ sessionId, data }), () => {});

  const a = service.open("/bin/bash", 80, 24).sessionId;
  const b = service.open("/bin/bash", 80, 24).sessionId;

  service.input(a, "echo aaa$(echo a11)\n");
  service.input(b, "echo bbb$(echo b22)\n");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      const aDone = output.some((o) => o.sessionId === a && o.data.includes("aaaa11"));
      const bDone = output.some((o) => o.sessionId === b && o.data.includes("bbbb22"));
      if (aDone && bDone) { clearInterval(check); resolve(); }
    }, 20);
  });

  // Each session's output only ever carries its own text, never the other's.
  expect(output.some((o) => o.sessionId === a && o.data.includes("bbbb22"))).toBe(false);
  expect(output.some((o) => o.sessionId === b && o.data.includes("aaaa11"))).toBe(false);

  service.closeAll();
}, 10000);

test("open recovers when node-pty's spawn-helper binary lost its executable bit (fresh-install permission bug)", async () => {
  // Root cause reproduced directly in this repo: bun (and, per node-pty
  // issue reports, npm in some layouts) extracts node-pty's prebuilt
  // "spawn-helper" native binary without the executable permission bit
  // set. node-pty's pty.spawn() then throws synchronously
  // ("Error: posix_spawnp failed") for *every* session, forever - which is
  // exactly what "the terminal panel doesn't load" looks like from the
  // outside. This is a filesystem-permission bug, not a startup race.
  const helperPath = findSpawnHelper();
  if (!helperPath) return; // e.g. win32, which has no spawn-helper binary

  const originalMode = statSync(helperPath).mode;
  chmodSync(helperPath, 0o644); // simulate the broken fresh-install state
  expect(statSync(helperPath).mode & 0o111).toBe(0); // confirm it's actually non-executable now

  try {
    const output: string[] = [];
    // Constructing the service (and thus spawning the pty-worker.js child)
    // happens *after* we stripped the executable bit, mirroring a daemon
    // that starts up right after a fresh `bun install` left the binary
    // broken - the worker's own self-heal (ensureNativeHelperExecutable in
    // pty-worker.js) must restore it before ever calling pty.spawn().
    const service = new PtyService(process.cwd(), (_id, data) => output.push(data), () => {});
    const { sessionId } = service.open("/bin/bash", 80, 24);
    service.input(sessionId, "echo pty_ready\n");

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (output.join("").includes("pty_ready")) { clearInterval(iv); resolve(); }
        if (Date.now() - start > 10000) { clearInterval(iv); reject(new Error("timed out waiting for pty output")); }
      }, 20);
    });

    service.closeAll();
  } finally {
    chmodSync(helperPath, originalMode);
  }
}, 10000);

test("resize does not throw for a live session", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  const { sessionId } = service.open("/bin/bash", 80, 24);
  expect(() => service.resize(sessionId, 100, 40)).not.toThrow();
  service.close(sessionId);
  service.closeAll();
});

test("input/resize/close on an unknown sessionId is a silent no-op", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  expect(() => service.input("nope", "x")).not.toThrow();
  expect(() => service.resize("nope", 10, 10)).not.toThrow();
  expect(() => service.close("nope")).not.toThrow();
  service.closeAll();
});

test("a worker crash drains all sessions and fires onExit for each", async () => {
  const exits: { sessionId: string; exitCode: number }[] = [];
  const service = new PtyService(
    process.cwd(),
    () => {},
    (sessionId, exitCode) => exits.push({ sessionId, exitCode }),
  );

  const a = service.open("/bin/bash", 80, 24).sessionId;
  const b = service.open("/bin/bash", 80, 24).sessionId;
  expect(service.list().length).toBe(2);

  const pid = service.workerPid;
  expect(pid).toBeDefined();
  process.kill(pid!, "SIGKILL");

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (exits.length >= 2) { clearInterval(check); resolve(); }
    }, 20);
  });

  expect(exits.map((e) => e.sessionId).sort()).toEqual([a, b].sort());
  // No phantom "live" sessions survive the worker's death: list() must
  // reflect the crash immediately, not keep reporting stale sessions that
  // silently swallow input/resize forever (the bug this test guards).
  expect(service.list()).toEqual([]);

  service.closeAll();
});

test("closeAll clears the session list synchronously", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  const a = service.open("/bin/bash", 80, 24).sessionId;
  const b = service.open("/bin/bash", 80, 24).sessionId;
  expect(service.list().map((s) => s.sessionId).sort()).toEqual([a, b].sort());
  service.closeAll();
  expect(service.list()).toEqual([]);
});
