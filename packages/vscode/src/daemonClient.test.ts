import { expect, test } from "bun:test";
import { DaemonClient } from "./daemonClient";

const discovery = (gatewayPort: number, gatewayApiKey: string) =>
  JSON.stringify({ mainPort: 9999, gatewayPort, gatewayApiKey });

test("reuses an already-running daemon without spawning", async () => {
  let spawned = false;
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => new Response(JSON.stringify({ nanoHostConnected: false, provider: "stub" }), { status: 200 })) as unknown as typeof fetch,
    spawnImpl: () => { spawned = true; return { unref() {} }; },
    readFile: async () => discovery(4821, "test-api-key"),
    sleep: async () => {},
  });

  const result = await client.ensureRunning();

  expect(result).toEqual({ port: 4821, apiKey: "test-api-key" });
  expect(spawned).toBe(false);
});

test("spawns zero serve with dynamic ports when no discovery file resolves to a healthy daemon", async () => {
  let calls = 0;
  let spawnedArgs: string[] = [];
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) throw new Error("connection refused");
      return new Response(JSON.stringify({ nanoHostConnected: false, provider: "stub" }), { status: 200 });
    }) as unknown as typeof fetch,
    spawnImpl: (_cmd, args) => { spawnedArgs = args; return { unref() {} }; },
    readFile: async () => discovery(51234, "spawned-api-key"),
    sleep: async () => {},
  });

  const result = await client.ensureRunning();

  expect(result).toEqual({ port: 51234, apiKey: "spawned-api-key" });
  expect(spawnedArgs).toEqual(["serve", "/tmp/proj", "--port", "0", "--gateway-port", "0"]);
});

test("ignores a stale discovery file from a dead daemon and spawns a fresh one", async () => {
  // The file is present (a prior daemon for this folder wrote it) but
  // nothing answers its port anymore - must not be mistaken for "running".
  let spawned = false;
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    spawnImpl: () => { spawned = true; return { unref() {} }; },
    readFile: async () => discovery(4821, "stale-api-key"),
    sleep: async () => {},
    maxAttempts: 1,
  });

  const result = await client.ensureRunning();

  expect(spawned).toBe(true);
  expect(result).toBeNull();
});

test("returns null when the daemon never comes up", async () => {
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    spawnImpl: () => ({ unref() {} }),
    readFile: async () => { throw new Error("no such file"); },
    sleep: async () => {},
    maxAttempts: 2,
  });

  const result = await client.ensureRunning();

  expect(result).toBeNull();
});

test("returns null when spawning zero fails (e.g. not on PATH)", async () => {
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    spawnImpl: () => { throw new Error("ENOENT"); },
    readFile: async () => { throw new Error("no such file"); },
    sleep: async () => {},
  });

  const result = await client.ensureRunning();

  expect(result).toBeNull();
});

test("ignores a malformed discovery file", async () => {
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => new Response(JSON.stringify({ provider: "stub" }), { status: 200 })) as unknown as typeof fetch,
    spawnImpl: () => ({ unref() {} }),
    readFile: async () => "not json",
    sleep: async () => {},
    maxAttempts: 1,
  });

  const result = await client.ensureRunning();

  expect(result).toBeNull();
});
