import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createTodoScanner } from "./index";
import { Workspace } from "../../workspace";
import type { PluginContext } from "../types";
import { useTempZeroHome } from "../../testSupport/zeroHome";

useTempZeroHome();

function makeContext(root: string): { ctx: PluginContext; methods: Map<string, (p: unknown) => Promise<unknown>> } {
  const methods = new Map<string, (p: unknown) => Promise<unknown>>();
  const ws = new Workspace(root);
  const ctx: PluginContext = {
    root,
    workspace: ws,
    broadcast: () => {},
    register: (method, schema, fn) => {
      methods.set(method, async (p: unknown) => fn((schema as z.ZodType).parse(p)));
    },
  };
  return { ctx, methods };
}

describe("createTodoScanner", () => {
  test("returns factory and getScanner", () => {
    const todos = createTodoScanner();
    expect(typeof todos.factory).toBe("function");
    expect(typeof todos.getScanner).toBe("function");
  });

  test("registers todos/list and todos/at, and scans the workspace on activate", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-todos-plugin-"));
    writeFileSync(join(root, "a.ts"), "// TODO: fix this\n");

    const todos = createTodoScanner();
    const { ctx, methods } = makeContext(root);
    const plugin = todos.factory(ctx);
    await plugin.activate(ctx);
    await todos.getScanner()?.waitUntilReady();

    const list = await methods.get("todos/list")?.({});
    expect(list).toEqual({ entries: [{ path: "a.ts", line: 1, kind: "TODO", text: "fix this" }] });
    const at = await methods.get("todos/at")?.({ path: "a.ts" });
    expect(at).toEqual({ entries: [{ path: "a.ts", line: 1, kind: "TODO", text: "fix this" }] });
    expect(plugin.health?.()).toEqual({ ok: true });
  });

  test("stays inert when todos.enabled is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-todos-disabled-"));
    const ws = new Workspace(root);
    await ws.writeSetting("todos.enabled", false);

    const todos = createTodoScanner();
    const { ctx, methods } = makeContext(root);
    const plugin = todos.factory(ctx);
    await plugin.activate(ctx);

    expect(methods.has("todos/list")).toBe(false);
    expect(methods.has("todos/at")).toBe(false);
    expect(plugin.health?.()).toEqual({ ok: true, detail: "disabled" });
  });
});
