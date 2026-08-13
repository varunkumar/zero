import { expect, test } from "bun:test";
import { startWatch } from "./watch";

test("poll path emits fs/changed for added and removed paths", async () => {
  let entries = [{ path: "a.ts" }];
  const events: string[] = [];
  const w = startWatch(
    { tree: async () => entries },
    (path) => events.push(path),
    { intervalMs: 10, observer: null },
  );
  await Bun.sleep(25);
  entries = [{ path: "a.ts" }, { path: "b.ts" }];
  await Bun.sleep(25);
  entries = [{ path: "b.ts" }];
  await Bun.sleep(25);
  w.stop();
  expect(events).toContain("b.ts");
  expect(events.filter((p) => p === "a.ts").length).toBeGreaterThan(0);
});

test("global FileSystemObserver without root still polls", async () => {
  const g = globalThis as unknown as {
    FileSystemObserver?: new (cb: unknown) => { observe?: unknown; disconnect?: () => void };
  };
  const prev = g.FileSystemObserver;
  let constructed = 0;
  let observeCalls = 0;

  g.FileSystemObserver = class {
    constructor(_cb: unknown) {
      constructed++;
    }
    observe() {
      observeCalls++;
    }
    disconnect() {}
  };

  try {
    let entries = [{ path: "a.ts" }];
    const events: string[] = [];
    // observer omitted; global stub present; no root → must poll, not dead observer path
    const w = startWatch(
      { tree: async () => entries },
      (path) => events.push(path),
      { intervalMs: 10 },
    );
    await Bun.sleep(25);
    entries = [{ path: "a.ts" }, { path: "b.ts" }];
    await Bun.sleep(25);
    entries = [{ path: "b.ts" }];
    await Bun.sleep(25);
    w.stop();

    expect(constructed).toBe(0);
    expect(observeCalls).toBe(0);
    expect(events).toContain("b.ts");
    expect(events.filter((p) => p === "a.ts").length).toBeGreaterThan(0);
  } finally {
    if (prev === undefined) {
      delete g.FileSystemObserver;
    } else {
      g.FileSystemObserver = prev;
    }
  }
});
