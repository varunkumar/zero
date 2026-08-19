import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitBlame } from "./blame";

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getGitBlame", () => {
  test("returns null for a non-git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-blame-nogit-"));
    writeFileSync(join(root, "a.txt"), "hi\n");
    expect(await getGitBlame(root, "a.txt")).toBeNull();
  });

  test("returns null for an untracked file", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-blame-untracked-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "b.txt"), "untracked\n");

    expect(await getGitBlame(root, "b.txt")).toBeNull();
  });

  test("attributes each line to its commit author", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-blame-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "Test User"]);
    writeFileSync(join(root, "a.txt"), "line one\nline two\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const blame = await getGitBlame(root, "a.txt");
    expect(blame?.lines).toHaveLength(2);
    expect(blame?.lines[0]).toMatchObject({ line: 1, author: "Test User" });
    expect(blame?.lines[1]).toMatchObject({ line: 2, author: "Test User" });
    expect(blame?.lines[0].commit).toBe(blame?.lines[1].commit);
    expect(blame?.lines[0].commit).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(blame!.lines[0].date).getTime()).not.toBeNaN();
  });

  test("attributes lines to different commits after an edit", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-blame-edit-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "Test User"]);
    writeFileSync(join(root, "a.txt"), "line one\nline two\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "a.txt"), "line one\nline two edited\n");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "edit"]);

    const blame = await getGitBlame(root, "a.txt");
    expect(blame?.lines[0].commit).not.toBe(blame?.lines[1].commit);
  });
});
