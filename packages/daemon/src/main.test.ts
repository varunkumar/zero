import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient, type SocketLike } from "@zero/protocol";
import { startZero } from "./main";

function wsAdapter(ws: WebSocket): SocketLike {
  const s: SocketLike = { send: (d) => ws.send(d), onmessage: null };
  ws.onmessage = (e) => s.onmessage?.(String(e.data));
  return s;
}

test("fs methods over the wire, watcher broadcasts", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "1");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));
  const changed = new Promise<unknown>((r) =>
    client.onNotification((m, p) => { if (m === "fs/changed") r(p); }));

  expect((await client.request<{ entries: { path: string }[] }>("fs/tree")).entries
    .map((e) => e.path)).toContain("a.ts");
  await client.request("fs/write", { path: "a.ts", content: "2" });
  expect((await client.request<{ content: string }>("fs/read", { path: "a.ts" })).content).toBe("2");
  expect(await changed).toEqual({ path: "a.ts" });
  ws.close(); d.stop();
});

test("fs/search and settings RPCs over the wire", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "const target = 1;\n");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const search = await client.request<{ matches: { path: string }[]; truncated: boolean }>(
    "fs/search", { query: "target" });
  expect(search.matches.map((m) => m.path)).toEqual(["a.ts"]);
  expect(search.truncated).toBe(false);

  expect(await client.request<{ value: unknown }>("settings/get", { key: "workbench" })).toEqual({ value: undefined });
  await client.request("settings/set", { key: "workbench", value: { theme: "dark" } });
  expect(await client.request<{ value: unknown }>("settings/get", { key: "workbench" })).toEqual({ value: { theme: "dark" } });

  ws.close(); d.stop();
});

test("lsp methods over the wire: sync, hover, definition, diagnostics broadcast", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  writeFileSync(join(root, "a.ts"), "const greeting: string = \"hi\";\nconsole.log(greeting);\n");
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const diagnosticEvents: unknown[] = [];
  client.onNotification((method, params) => { if (method === "lsp/diagnostics") diagnosticEvents.push(params); });

  await client.request("lsp/sync", { path: "a.ts", content: "const greeting: string = \"hi\";\nconsole.log(greeting);\n" });
  const hover = await client.request<{ contents: string | null }>(
    "lsp/hover", { path: "a.ts", position: { line: 0, character: 6 } });
  expect(hover.contents).toBeTruthy();

  const definition = await client.request<{ locations: { path: string }[] }>(
    "lsp/definition", { path: "a.ts", position: { line: 1, character: 12 } });
  expect(definition.locations.length).toBeGreaterThan(0);

  await client.request("lsp/sync", { path: "a.ts", content: "const greeting: string = 42;\n" });
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (diagnosticEvents.length > 0) { clearInterval(check); resolve(); } }, 50);
  });

  ws.close(); d.stop();
}, 20000);

test("pty methods over the wire: open, input/output, resize, close", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-"));
  const d = await startZero({ root });
  const ws = await new Promise<WebSocket>((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${d.port}/rpc?token=${d.token}`);
    w.onopen = () => res(w); w.onerror = rej;
  });
  const client = new RpcClient(wsAdapter(ws));

  const outputs: unknown[] = [];
  client.onNotification((method, params) => { if (method === "pty/output") outputs.push(params); });

  const { sessionId, shell } = await client.request<{ sessionId: string; shell: string }>(
    "pty/open", { shell: "/bin/sh", cols: 80, rows: 24 });
  expect(shell).toBe("/bin/sh");

  const listed = await client.request<{ sessions: { sessionId: string; shell: string }[] }>("pty/list");
  expect(listed.sessions).toEqual([{ sessionId, shell: "/bin/sh" }]);

  await client.request("pty/input", { sessionId, data: "echo pty-wire-test\n" });
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (outputs.some((o) => typeof o === "object" && o !== null && "data" in o
        && String((o as { data: unknown }).data).includes("pty-wire-test"))) {
        clearInterval(check);
        resolve();
      }
    }, 20);
  });

  await client.request("pty/resize", { sessionId, cols: 100, rows: 40 });
  await client.request("pty/close", { sessionId });
  const listedAfter = await client.request<{ sessions: unknown[] }>("pty/list");
  expect(listedAfter.sessions).toEqual([]);

  ws.close(); d.stop();
});
