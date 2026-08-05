import { expect, test } from "bun:test";
import { PtyService } from "./pty";

test("open spawns a shell, input/output round-trips, close kills it", async () => {
  const output: { sessionId: string; data: string }[] = [];
  const exits: { sessionId: string; exitCode: number }[] = [];
  const service = new PtyService(
    process.cwd(),
    (sessionId, data) => output.push({ sessionId, data }),
    (sessionId, exitCode) => exits.push({ sessionId, exitCode }),
  );

  const { sessionId, shell } = service.open("/bin/sh", 80, 24);
  expect(shell).toBe("/bin/sh");
  expect(service.list()).toEqual([{ sessionId, shell: "/bin/sh" }]);

  service.input(sessionId, "echo hello-pty\n");
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (output.some((o) => o.sessionId === sessionId && o.data.includes("hello-pty"))) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  service.close(sessionId);
  await new Promise((r) => setTimeout(r, 100));
  expect(service.list()).toEqual([]);
});

test("resize does not throw for a live session", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  const { sessionId } = service.open("/bin/sh", 80, 24);
  expect(() => service.resize(sessionId, 100, 40)).not.toThrow();
  service.close(sessionId);
});

test("input/resize/close on an unknown sessionId is a silent no-op", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  expect(() => service.input("nope", "x")).not.toThrow();
  expect(() => service.resize("nope", 10, 10)).not.toThrow();
  expect(() => service.close("nope")).not.toThrow();
});

test("closeAll kills every session", () => {
  const exits: string[] = [];
  const service = new PtyService(process.cwd(), () => {}, (sessionId) => exits.push(sessionId));
  const a = service.open("/bin/sh", 80, 24).sessionId;
  const b = service.open("/bin/sh", 80, 24).sessionId;
  service.closeAll();
  expect(service.list()).toEqual([]);
  expect(exits.sort()).toEqual([a, b].sort());
});
