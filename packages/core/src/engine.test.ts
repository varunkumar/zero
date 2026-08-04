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

test("re-checks availability after cache expires, but not on repeated hits", async () => {
  let calls = 0;
  let avail = false;
  const provider = fakeProvider("m", true);
  provider.available = async () => { calls++; return avail; };
  const engine = new CompletionEngine({ providers: [provider], context: [] });

  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    // first call: cache miss, must call available()
    expect(await engine.complete(req, new AbortController().signal)).toBeNull();
    expect(calls).toBe(1);

    // Repeated calls at 10s intervals (each one individually within the 30s
    // TTL of the *previous* call) that cumulatively span 50s since the
    // original check. This is the shape of the actual bug: a buggy #pick
    // that refreshes the cache timestamp on every hit (not just on a real
    // recheck) never lets the entry expire as long as requests keep arriving
    // faster than every 30s -- "available() called once for the entire
    // process lifetime" per the finding. A correct implementation only
    // touches the timestamp when it actually calls available(), so the
    // entry set at t=0 expires once >=30s have elapsed from t=0, regardless
    // of how many cache hits happened in between.
    for (let i = 0; i < 5; i++) {
      now += 10_000;
      expect(await engine.complete(req, new AbortController().signal)).toBeNull();
    }
    // By now 50s have elapsed since the original (unrefreshed) timestamp,
    // so exactly one recheck should have happened along the way.
    expect(calls).toBe(2);

    // Flip availability and advance past the TTL again: must re-check and
    // pick up the now-available provider.
    avail = true;
    now += 31_000;
    const out = await engine.complete(req, new AbortController().signal);
    expect(out).toBe("done()");
    expect(calls).toBe(3);
  } finally {
    Date.now = realNow;
  }
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
