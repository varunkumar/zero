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
