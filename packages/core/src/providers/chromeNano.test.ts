import { expect, test } from "bun:test";
import { ChromeNanoProvider, probeNano, type NanoApi } from "./chromeNano";

function fakeApi(state: "available" | "downloadable" | "unavailable"): NanoApi {
  return {
    availability: async () => state,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { yield "echo:"; yield input.slice(0, 4); },
      destroy() {},
    }),
  };
}

test("probe maps states", async () => {
  expect(await probeNano(undefined)).toBe("unavailable");
  expect(await probeNano(fakeApi("downloadable"))).toBe("downloadable");
  expect(await probeNano(fakeApi("available"))).toBe("ready");
});

test("available only when ready", async () => {
  expect(await new ChromeNanoProvider(undefined).available()).toBe(false);
  expect(await new ChromeNanoProvider(fakeApi("downloadable")).available()).toBe(false);
  expect(await new ChromeNanoProvider(fakeApi("available")).available()).toBe(true);
});

test("streams from a session", async () => {
  const p = new ChromeNanoProvider(fakeApi("available"));
  let out = "";
  for await (const t of p.complete("test", new AbortController().signal)) out += t;
  expect(out).toBe("echo:test");
});

test("chat() renders messages into a transcript and streams the session's response", async () => {
  let capturedPrompt = "";
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { capturedPrompt = input; yield "Hi"; yield " there"; },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  let out = "";
  for await (const delta of provider.chat(
    [{ role: "system", content: "Be helpful.", createdAt: 0 }, { role: "user", content: "hello", createdAt: 1 }],
    [], new AbortController().signal,
  )) {
    if (delta.text) out += delta.text;
  }
  expect(out).toBe("Hi there");
  expect(capturedPrompt).toContain("system: Be helpful.");
  expect(capturedPrompt).toContain("user: hello");
});

test("supportsTools() is false", () => {
  expect(new ChromeNanoProvider(undefined).supportsTools()).toBe(false);
});

test("chat() only sends the new turn on a second call, reusing the session", async () => {
  let createCalls = 0;
  const prompts: string[] = [];
  const api = {
    availability: async () => "available" as const,
    create: async () => {
      createCalls++;
      return {
        inputQuota: 6144,
        async *promptStreaming(input: string) { prompts.push(input); yield "ok"; },
        destroy() {},
      };
    },
  };
  const provider = new ChromeNanoProvider(api);
  const base = [
    { role: "system" as const, content: "Be helpful.", createdAt: 0 },
    { role: "user" as const, content: "hello", createdAt: 1 },
  ];
  for await (const _ of provider.chat(base, [], new AbortController().signal)) { /* drain */ }

  const grown = [
    ...base,
    { role: "assistant" as const, content: "hi", createdAt: 2 },
    { role: "user" as const, content: "more", createdAt: 3 },
  ];
  for await (const _ of provider.chat(grown, [], new AbortController().signal)) { /* drain */ }

  expect(createCalls).toBe(1);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).not.toContain("Be helpful.");
  expect(prompts[1]).toContain("user: more");
});

test("chat() recreates the session when the conversation resets (shorter history)", async () => {
  let createCalls = 0;
  const api = {
    availability: async () => "available" as const,
    create: async () => {
      createCalls++;
      return { inputQuota: 6144, async *promptStreaming() { yield "ok"; }, destroy() {} };
    },
  };
  const provider = new ChromeNanoProvider(api);
  const long = [
    { role: "system" as const, content: "s", createdAt: 0 },
    { role: "user" as const, content: "a", createdAt: 1 },
    { role: "assistant" as const, content: "b", createdAt: 2 },
  ];
  for await (const _ of provider.chat(long, [], new AbortController().signal)) { /* drain */ }
  const shorter = [{ role: "user" as const, content: "new convo", createdAt: 10 }];
  for await (const _ of provider.chat(shorter, [], new AbortController().signal)) { /* drain */ }
  expect(createCalls).toBe(2);
});

test("chat() with tools requests constrained decoding and parses a tool_call", async () => {
  let capturedConstraint: unknown;
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(_input: string, opts?: { responseConstraint?: object }) {
        capturedConstraint = opts?.responseConstraint;
        yield JSON.stringify({ kind: "tool_call", tool: "fs_read", input: { path: "a.ts" } });
      },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  const tools = [{ name: "fs_read", description: "read", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "read a.ts", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toHaveLength(1);
  expect(deltas[0]!.toolCalls![0]!.name).toBe("fs_read");
  expect(capturedConstraint).toBeTruthy();
});

test("chat() with tools falls back to plain text when the model ignores the constraint", async () => {
  const api = {
    availability: async () => "available" as const,
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming() { yield "I refuse to use tools."; },
      destroy() {},
    }),
  };
  const provider = new ChromeNanoProvider(api);
  const tools = [{ name: "fs_read", description: "read", schema: { type: "object" } }];
  const deltas = [];
  for await (const d of provider.chat([{ role: "user", content: "hi", createdAt: 0 }], tools, new AbortController().signal)) {
    deltas.push(d);
  }
  expect(deltas).toEqual([{ text: "I refuse to use tools." }]);
});
