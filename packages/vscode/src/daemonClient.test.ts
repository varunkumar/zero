import { expect, test } from "bun:test";
import { DaemonClient, DEFAULT_GATEWAY_PORT } from "./daemonClient";

test("DEFAULT_GATEWAY_PORT is 4821", () => {
  expect(DEFAULT_GATEWAY_PORT).toBe(4821);
});

test("reuses an already-running daemon without spawning", async () => {
  let spawned = false;
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => new Response(JSON.stringify({ nanoHostConnected: false, provider: "stub" }), { status: 200 })) as unknown as typeof fetch,
    spawnImpl: () => { spawned = true; return { unref() {} }; },
    readFile: async () => "test-api-key",
    sleep: async () => {},
  });

  const result = await client.ensureRunning(4821);

  expect(result).toEqual({ port: 4821, apiKey: "test-api-key" });
  expect(spawned).toBe(false);
});

test("spawns zero serve when no daemon answers, then retries", async () => {
  let calls = 0;
  let spawnedArgs: string[] = [];
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) throw new Error("connection refused");
      return new Response(JSON.stringify({ nanoHostConnected: false, provider: "stub" }), { status: 200 });
    }) as unknown as typeof fetch,
    spawnImpl: (_cmd, args) => { spawnedArgs = args; return { unref() {} }; },
    readFile: async () => "spawned-api-key",
    sleep: async () => {},
  });

  const result = await client.ensureRunning(4821);

  expect(result).toEqual({ port: 4821, apiKey: "spawned-api-key" });
  expect(spawnedArgs).toEqual(["serve", "/tmp/proj", "--gateway-port", "4821"]);
});

test("returns null when the daemon never comes up", async () => {
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    spawnImpl: () => ({ unref() {} }),
    readFile: async () => { throw new Error("no such file"); },
    sleep: async () => {},
    maxAttempts: 2,
  });

  const result = await client.ensureRunning(4821);

  expect(result).toBeNull();
});

test("returns null when spawning zero fails (e.g. not on PATH)", async () => {
  const client = new DaemonClient("/tmp/proj", {
    fetchImpl: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
    spawnImpl: () => { throw new Error("ENOENT"); },
    readFile: async () => "unused",
    sleep: async () => {},
  });

  const result = await client.ensureRunning(4821);

  expect(result).toBeNull();
});
