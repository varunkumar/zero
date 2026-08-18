import { expect, test } from "bun:test";
import { RpcClient, type SessionHelloResult } from "@zero/protocol";
import { createMemRoot } from "./memDir";
import { BrowserFSWorkspace } from "./browserFs";
import { createLocalSocket } from "./localRpc";

async function clientFor(name = "proj") {
  const root = createMemRoot(name);
  const f = await (await root.getDirectoryHandle("src", { create: true }))
    .getFileHandle("a.ts", { create: true });
  const w = await f.createWritable(); await w.write("hi"); await w.close();
  const fs = new BrowserFSWorkspace(root);
  const socket = createLocalSocket({ workspaceName: name, fs });
  return { client: new RpcClient(socket), socket, fs };
}

test("session/hello reports lite flags", async () => {
  const { client } = await clientFor("demo");
  expect(await client.request<SessionHelloResult>("session/hello")).toEqual({
    capabilities: { pty: false, lsp: false, graph: false, git: false, models: ["nano"] },
    workspace: { name: "demo", kind: "browser-fs" },
  });
});

test("fs/read and fs/write round-trip and emit fs/changed", async () => {
  const { client } = await clientFor();
  const changed = new Promise<unknown>((r) =>
    client.onNotification((m, p) => { if (m === "fs/changed") r(p); }));
  expect((await client.request<{ content: string }>("fs/read", { path: "src/a.ts" })).content).toBe("hi");
  await client.request("fs/write", { path: "src/a.ts", content: "yo" });
  expect(await changed).toEqual({ path: "src/a.ts" });
  expect((await client.request<{ content: string }>("fs/read", { path: "src/a.ts" })).content).toBe("yo");
});

test("unknown methods return method-not-found", async () => {
  const { client } = await clientFor();
  await expect(client.request("pty/open", { cols: 80, rows: 24 }))
    .rejects.toThrow("method not available in lite");
});

test("settings/get has no value so localStorage wins", async () => {
  const { client } = await clientFor();
  expect(await client.request<Record<string, never>>("settings/get", { key: "workbench" })).toEqual({});
});

test("fs/readBinary dispatches to opts.fs.readBinary and returns its result", async () => {
  const { client } = await clientFor();
  const result = await client.request<{ contentBase64: string; mimeType: string }>("fs/readBinary", {
    path: "src/a.ts",
  });
  expect(result.mimeType).toBe("application/octet-stream");
  expect(atob(result.contentBase64)).toBe("hi");
});

test("extra hook routes chat/* methods through RpcClient", async () => {
  const root = createMemRoot("proj");
  const fs = new BrowserFSWorkspace(root);
  const sessions = new Map<string, { id: string; title: string }>();
  const socket = createLocalSocket({
    workspaceName: "proj",
    fs,
    extra: async (method, params) => {
      if (method === "chat/create") {
        const id = crypto.randomUUID();
        sessions.set(id, { id, title: "New chat" });
        return { id };
      }
      if (method === "chat/list") return { sessions: [...sessions.values()] };
      throw Object.assign(new Error("method not available in lite"), { code: -32601 });
    },
  });
  const client = new RpcClient(socket);
  const { id } = await client.request<{ id: string }>("chat/create", {});
  expect(id).toBeTruthy();
  const { sessions: list } = await client.request<{ sessions: { id: string }[] }>("chat/list", {});
  expect(list.map((s) => s.id)).toEqual([id]);
});
