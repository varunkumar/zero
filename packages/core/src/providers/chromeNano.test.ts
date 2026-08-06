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
