import { expect, test } from "bun:test";
import { setupNanoHost } from "./nanoHost";
import type { NanoApi } from "@zero/core";

function fakeClient() {
  const sent: { method: string; params: unknown }[] = [];
  const requested: { method: string; params: unknown }[] = [];
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    sent, requested,
    notify: (method: string, params: unknown) => { sent.push({ method, params }); },
    request: async <R,>(method: string, params?: unknown): Promise<R> => { requested.push({ method, params }); return {} as R; },
    onRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => requestHandlers.set(method, handler),
    __invoke: (method: string, params: unknown) => requestHandlers.get(method)!(params),
  };
}

function fakeDoc(initial: "visible" | "hidden") {
  let handler: (() => void) | null = null;
  const doc = {
    visibilityState: initial as "visible" | "hidden",
    addEventListener: (_type: string, h: () => void) => { handler = h; },
    fire(state: "visible" | "hidden") { doc.visibilityState = state; handler?.(); },
  };
  return doc;
}

function readyNanoApi(): NanoApi {
  return {
    availability: async () => "available",
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string) { yield "ok:" + input.slice(0, 3); },
      destroy() {},
    }),
  };
}

test("registers once Nano is ready and the doc is visible", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("visible") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([{ method: "nano/register", params: undefined }]);
});

test("does not register when Nano is unavailable", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: undefined, doc: fakeDoc("visible") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([]);
});

test("does not register while the tab starts hidden", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("hidden") });
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested).toEqual([]);
});

test("unregisters on visibilitychange to hidden, re-registers on visible", async () => {
  const client = fakeClient();
  const doc = fakeDoc("visible");
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc });
  await new Promise((r) => setTimeout(r, 0));
  doc.fire("hidden");
  await new Promise((r) => setTimeout(r, 0));
  doc.fire("visible");
  await new Promise((r) => setTimeout(r, 0));
  expect(client.requested.map((r) => r.method)).toEqual(["nano/register", "nano/unregister", "nano/register"]);
});

/** A Nano fake whose generation blocks until `release()` is called, so
 * overlapping requests are observable. */
function gatedNanoApi() {
  const started: string[] = [];
  let release: (() => void) | null = null;
  const api: NanoApi = {
    availability: async () => "available",
    create: async () => ({
      inputQuota: 6144,
      async *promptStreaming(input: string, o?: { signal?: AbortSignal }) {
        started.push(input);
        await new Promise<void>((r) => {
          release = r;
          o?.signal?.addEventListener("abort", () => r());
        });
        if (o?.signal?.aborted) return;
        yield "done";
      },
      destroy() {},
    }),
  };
  return { api, started, release: () => { const r = release; release = null; r?.(); } };
}

test("nano/chat requests are serialized against the shared Nano session", async () => {
  const client = fakeClient();
  const gated = gatedNanoApi();
  setupNanoHost({ client, nanoApi: gated.api, doc: fakeDoc("visible") });

  const first = client.__invoke("nano/chat", { requestId: "r1", messages: [{ role: "user", content: "one", createdAt: 0 }], tools: [] });
  const second = client.__invoke("nano/chat", { requestId: "r2", messages: [{ role: "user", content: "two", createdAt: 1 }], tools: [] });

  await new Promise((r) => setTimeout(r, 10));
  expect(gated.started).toHaveLength(1);
  expect(gated.started[0]).toContain("user: one");

  gated.release();
  await first;
  await new Promise((r) => setTimeout(r, 10));
  expect(gated.started).toHaveLength(2);
  expect(gated.started[1]).toContain("user: two");

  gated.release();
  expect(await second).toEqual({ done: true });
});

test("nano/cancel aborts only the matching in-flight request", async () => {
  const client = fakeClient();
  const gated = gatedNanoApi();
  setupNanoHost({ client, nanoApi: gated.api, doc: fakeDoc("visible") });

  const first = client.__invoke("nano/chat", { requestId: "r1", messages: [{ role: "user", content: "one", createdAt: 0 }], tools: [] });
  const second = client.__invoke("nano/chat", { requestId: "r2", messages: [{ role: "user", content: "two", createdAt: 1 }], tools: [] });
  await new Promise((r) => setTimeout(r, 10));

  // Cancelling the queued r2 must not disturb the running r1.
  await client.__invoke("nano/cancel", { requestId: "r2" });
  await new Promise((r) => setTimeout(r, 10));
  expect(gated.started).toHaveLength(1);

  gated.release();
  expect(await first).toEqual({ done: true });
  expect(await second).toEqual({ done: true });
  // r2 was aborted before it ever reached the session.
  expect(gated.started).toHaveLength(1);
  expect(client.sent.map((s) => (s.params as { requestId: string }).requestId)).toEqual(["r1"]);
});

test("nano/cancel aborts a running request mid-stream", async () => {
  const client = fakeClient();
  const gated = gatedNanoApi();
  setupNanoHost({ client, nanoApi: gated.api, doc: fakeDoc("visible") });

  const first = client.__invoke("nano/chat", { requestId: "r1", messages: [{ role: "user", content: "one", createdAt: 0 }], tools: [] });
  await new Promise((r) => setTimeout(r, 10));
  expect(gated.started).toHaveLength(1);

  await client.__invoke("nano/cancel", { requestId: "r1" });
  expect(await first).toEqual({ done: true });
  expect(client.sent).toEqual([]);
});

test("answers nano/chat by running ChromeNanoProvider locally and forwarding deltas as notifications", async () => {
  const client = fakeClient();
  setupNanoHost({ client, nanoApi: readyNanoApi(), doc: fakeDoc("visible") });
  const result = await client.__invoke("nano/chat", {
    requestId: "r1",
    messages: [{ role: "user", content: "hey", createdAt: 0 }],
    tools: [],
  });
  expect(result).toEqual({ done: true });
  expect(client.sent).toEqual([{ method: "nano/chatDelta", params: { requestId: "r1", delta: { text: "ok:use" } } }]);
});
