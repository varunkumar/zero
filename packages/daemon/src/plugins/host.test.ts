import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../rpc";
import { Workspace } from "../workspace";
import { PluginHost } from "./host";
import type { PluginContext, ZeroPlugin } from "./types";

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "zero-ph-"));
  const rpc = new RpcServer();
  const workspace = new Workspace(root);
  const broadcasts: { method: string; params: unknown }[] = [];
  const host = new PluginHost({
    rpc, workspace, root,
    broadcast: (method, params) => broadcasts.push({ method, params }),
  });
  host.registerHostRpcs();
  return { host, rpc, root, broadcasts };
}

test("activateBuiltins lists healthy plugin and registers its methods", async () => {
  const { host, rpc } = makeHost();
  const factory = (ctx: PluginContext): ZeroPlugin => {
    ctx.register("demo/ping", z.object({}), async () => ({ pong: true }));
    return {
      manifest: {
        id: "demo", name: "Demo", version: "1.0.0",
        contributions: { rpcMethods: ["demo/ping"] },
      },
      activate() {},
      health: () => ({ ok: true }),
    };
  };
  await host.activateBuiltins([factory]);
  const list = host.list();
  expect(list.plugins).toHaveLength(1);
  expect(list.plugins[0]!.id).toBe("demo");
  expect(list.plugins[0]!.health.ok).toBe(true);

  const raw = await rpc.dispatch(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "demo/ping", params: {},
  }));
  expect(JSON.parse(raw!).result).toEqual({ pong: true });

  const listRaw = await rpc.dispatch(JSON.stringify({
    jsonrpc: "2.0", id: 2, method: "plugin/list", params: {},
  }));
  expect(JSON.parse(listRaw!).result.plugins[0].id).toBe("demo");
});

test("activate failure marks plugin unhealthy and does not throw", async () => {
  const { host } = makeHost();
  const bad = (): ZeroPlugin => ({
    manifest: { id: "bad", name: "Bad", version: "0.0.1", contributions: {} },
    activate() { throw new Error("boom"); },
  });
  await host.activateBuiltins([bad]);
  expect(host.list().plugins[0]!.health.ok).toBe(false);
  expect(host.list().plugins[0]!.health.detail).toContain("boom");
  expect(host.health().ok).toBe(false);
});

test("failed activate is not masked by later health() reporting ok", async () => {
  const { host } = makeHost();
  const sneaky = (): ZeroPlugin => ({
    manifest: {
      id: "sneaky",
      name: "Sneaky",
      version: "0.0.1",
      contributions: {},
    },
    activate() {
      throw new Error("activate failed");
    },
    health: () => ({ ok: true, detail: "looks fine" }),
  });
  await host.activateBuiltins([sneaky]);
  const h = host.list().plugins[0]!.health;
  expect(h.ok).toBe(false);
  expect(h.detail).toContain("activate failed");
  expect(host.health().plugins.sneaky?.ok).toBe(false);
  expect(host.health().plugins.sneaky?.detail).toContain("activate failed");
});

test("activateBuiltins passes through a ui contribution untouched", async () => {
  const { host, rpc } = makeHost();
  const factory = (): ZeroPlugin => ({
    manifest: {
      id: "demo-ui", name: "Demo UI", version: "1.0.0",
      contributions: { ui: { entry: "ui/dist/index.js" } },
    },
    activate() {},
  });
  await host.activateBuiltins([factory]);
  const list = host.list();
  expect(list.plugins.find((p) => p.id === "demo-ui")?.contributions.ui)
    .toEqual({ entry: "ui/dist/index.js" });
  void rpc; // unused in this test, keep destructure consistent with makeHost()'s return shape
});
