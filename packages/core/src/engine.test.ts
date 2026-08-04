import { expect, test } from "bun:test";
import { CompletionEngine } from "./engine";
import { CompletionScheduler } from "./scheduler";
import type { ModelProvider } from "./types";

function fakeProvider(id: string, avail: boolean, output = "done()"): ModelProvider {
  return {
    id, available: async () => avail,
    capabilities: () => ({ id, contextWindowTokens: 1000, supportsFim: true }),
    async *complete(_prompt, signal) {
      for (const ch of output) { if (signal.aborted) return; yield ch; }
    },
  };
}
const req = { path: "a.ts", prefix: "const a = ", suffix: "" };

test("uses first available provider and streams result", async () => {
  const engine = new CompletionEngine({
    providers: [fakeProvider("nano", false), fakeProvider("ollama", true)],
    context: [],
  });
  const out = await engine.complete(req, new AbortController().signal);
  expect(out).toBe("done()");
  expect(engine.status()).toEqual({ activeModel: "ollama", reason: null });
});

test("returns null and sets reason when nothing available", async () => {
  const engine = new CompletionEngine({ providers: [fakeProvider("nano", false)], context: [] });
  expect(await engine.complete(req, new AbortController().signal)).toBeNull();
  expect(engine.status()).toEqual({ activeModel: null, reason: "no model available" });
});

test("abort mid-stream returns null", async () => {
  const engine = new CompletionEngine({ providers: [fakeProvider("m", true)], context: [] });
  const ctl = new AbortController();
  ctl.abort();
  expect(await engine.complete(req, ctl.signal)).toBeNull();
});

test("scheduler debounces and aborts previous run", async () => {
  const signals: AbortSignal[] = [];
  let runs = 0;
  const sched = new CompletionScheduler(async (signal) => { runs++; signals.push(signal); }, 10);
  sched.trigger(); sched.trigger(); sched.trigger();
  await new Promise((r) => setTimeout(r, 30));
  expect(runs).toBe(1);
  sched.trigger();
  await new Promise((r) => setTimeout(r, 30));
  expect(runs).toBe(2);
  expect(signals[0]!.aborted).toBe(true);
});
