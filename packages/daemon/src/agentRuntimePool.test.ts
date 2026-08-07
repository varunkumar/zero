import { expect, test } from "bun:test";
import type { AgentRuntime } from "@zero/core";
import { createRuntimePool } from "./agentRuntimePool";

test("concurrent callers for a brand-new session converge on the same in-flight construction", async () => {
  let buildCalls = 0;
  const runtimeFor = createRuntimePool(async (sessionId) => {
    buildCalls++;
    // Simulate the real async gap (e.g. `await buildProviders()`) that let
    // two concurrent callers both miss the cache before either wrote to it.
    await Bun.sleep(10);
    return { sessionId } as unknown as AgentRuntime;
  });

  const [a, b] = await Promise.all([runtimeFor("s1"), runtimeFor("s1")]);

  expect(a).toBe(b);
  expect(buildCalls).toBe(1);
});

test("different sessions still get independent runtimes", async () => {
  const runtimeFor = createRuntimePool(async (sessionId) => ({ sessionId }) as unknown as AgentRuntime);
  const [a, b] = await Promise.all([runtimeFor("s1"), runtimeFor("s2")]);
  expect(a).not.toBe(b);
});

test("a later call after the first resolves reuses the cached instance", async () => {
  let buildCalls = 0;
  const runtimeFor = createRuntimePool(async (sessionId) => {
    buildCalls++;
    return { sessionId } as unknown as AgentRuntime;
  });
  const a = await runtimeFor("s1");
  const b = await runtimeFor("s1");
  expect(a).toBe(b);
  expect(buildCalls).toBe(1);
});

test("a failed construction is evicted, so a later call retries instead of re-rejecting forever", async () => {
  let buildCalls = 0;
  const runtimeFor = createRuntimePool(async (sessionId) => {
    buildCalls++;
    if (buildCalls === 1) throw new Error("transient settings read failure");
    return { sessionId } as unknown as AgentRuntime;
  });

  await expect(runtimeFor("s1")).rejects.toThrow("transient settings read failure");
  // The rejected promise's .catch-based eviction runs as a microtask after
  // rejection; give it a tick before asserting the retry succeeds.
  await Bun.sleep(0);

  const rt = await runtimeFor("s1");
  expect(rt).toEqual({ sessionId: "s1" });
  expect(buildCalls).toBe(2);
});

test("concurrent callers during a failed construction all see the same rejection (no separate builds)", async () => {
  let buildCalls = 0;
  const runtimeFor = createRuntimePool(async (sessionId) => {
    buildCalls++;
    await Bun.sleep(10);
    throw new Error(`build failed for ${sessionId}`);
  });

  const results = await Promise.allSettled([runtimeFor("s1"), runtimeFor("s1")]);
  expect(results[0].status).toBe("rejected");
  expect(results[1].status).toBe("rejected");
  expect((results[0] as PromiseRejectedResult).reason).toBe((results[1] as PromiseRejectedResult).reason);
  // Both concurrent callers awaited the same in-flight (failing)
  // construction rather than each triggering their own build.
  expect(buildCalls).toBe(1);
});
