import { expect, test } from "bun:test";
import { PtyService } from "./pty";

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
