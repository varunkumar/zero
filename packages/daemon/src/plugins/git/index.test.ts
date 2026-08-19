import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createGit } from "./index";
import { Workspace } from "../../workspace";
import type { PluginContext } from "../types";
import { useTempZeroHome } from "../../testSupport/zeroHome";

useTempZeroHome();

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

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

describe("git plugin", () => {
  test("registers git/status and git/blame, and reports healthy for a repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-plugin-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const { factory } = createGit();
    const { ctx, methods } = makeContext(root);
    const plugin = factory(ctx);
    await plugin.activate(ctx);

    expect(plugin.health?.()).toEqual({ ok: true });
    const status = await methods.get("git/status")?.({});
    expect(status).toEqual({ status: expect.objectContaining({ branch: "main" }) });
    const blame = await methods.get("git/blame")?.({ path: "a.txt" });
    expect(blame).toEqual({ blame: expect.objectContaining({ lines: expect.any(Array) }) });
  });

  test("stays inert when git.enabled is false", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-disabled-"));
    const ws = new Workspace(root);
    await ws.writeSetting("git.enabled", false);

    const { factory } = createGit();
    const { ctx, methods } = makeContext(root);
    const plugin = factory(ctx);
    await plugin.activate(ctx);

    expect(methods.has("git/status")).toBe(false);
    expect(methods.has("git/blame")).toBe(false);
    expect(plugin.health?.()).toEqual({ ok: true, detail: "disabled" });
  });
});
