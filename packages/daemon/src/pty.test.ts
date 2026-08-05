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

  const { sessionId, shell } = service.open("/bin/bash", 80, 24);
  expect(shell).toBe("/bin/bash");
  expect(service.list()).toEqual([{ sessionId, shell: "/bin/bash" }]);

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

test("closeAll clears the session list synchronously", () => {
  const service = new PtyService(process.cwd(), () => {}, () => {});
  const a = service.open("/bin/bash", 80, 24).sessionId;
  const b = service.open("/bin/bash", 80, 24).sessionId;
  expect(service.list().map((s) => s.sessionId).sort()).toEqual([a, b].sort());
  service.closeAll();
  expect(service.list()).toEqual([]);
});
