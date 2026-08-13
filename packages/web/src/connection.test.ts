import { expect, test } from "bun:test";
import type { SessionHelloResult } from "@zero/protocol";
import { connectLite, probeDaemon, shouldUseDaemon } from "./connection";
import { createMemRoot } from "./lite/memDir";

test("token query param means daemon mode", () => {
  expect(shouldUseDaemon("?token=abc")).toBe(true);
  expect(shouldUseDaemon("?foo=1", "envtok")).toBe(true);
  expect(shouldUseDaemon("")).toBe(false);
  expect(shouldUseDaemon("?foo=1")).toBe(false);
});

test("probeDaemon is true only when the probe gets a 401 (daemon present, unauthenticated)", async () => {
  expect(await probeDaemon({ fetch: async () => ({ status: 401 }) })).toBe(true);
});

test("probeDaemon is false for a 200 (static origin's SPA fallback)", async () => {
  expect(await probeDaemon({ fetch: async () => ({ status: 200 }) })).toBe(false);
});

test("probeDaemon is false when the fetch rejects (nothing listening)", async () => {
  expect(
    await probeDaemon({
      fetch: async () => {
        throw new Error("network");
      },
    }),
  ).toBe(false);
});

test("probeDaemon is false when the fetch never settles before the timeout", async () => {
  const result = await probeDaemon({
    timeoutMs: 5,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  expect(result).toBe(false);
});

test("connectLite wires workspace+socket+watch for RPC round trips", async () => {
  const root = createMemRoot("proj");
  const conn = connectLite(root, "proj", "r1", 10);

  const hello = await conn.client.request<SessionHelloResult>("session/hello");
  expect(hello.workspace).toEqual({ name: "proj", kind: "browser-fs" });

  await conn.client.request("fs/write", { path: "a.ts", content: "hi" });
  expect(await conn.client.request<{ content: string }>("fs/read", { path: "a.ts" })).toEqual({
    content: "hi",
  });

  conn.close();
});

test("connectLite's close() stops the watcher", async () => {
  const root = createMemRoot("proj");
  const conn = connectLite(root, "proj", "r1", 10);

  const paths: string[] = [];
  conn.client.onNotification((method, params) => {
    if (method === "fs/changed") paths.push((params as { path: string }).path);
  });

  // Let the poll's first tick establish its baseline snapshot of the
  // (currently empty) tree before we add anything.
  await Bun.sleep(25);

  // Change made directly on the handle (not through the RPC client, which
  // would notify on its own) - only the watcher's poll can observe this.
  await root.getFileHandle("b.ts", { create: true });
  await Bun.sleep(35);
  expect(paths).toContain("b.ts");

  conn.close();
  paths.length = 0;

  await root.getFileHandle("c.ts", { create: true });
  await Bun.sleep(35);
  expect(paths).toEqual([]);
});
