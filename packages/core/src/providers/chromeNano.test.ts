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
