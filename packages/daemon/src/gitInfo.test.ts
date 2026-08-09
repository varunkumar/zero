import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitStatus } from "./gitInfo";

async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getGitStatus", () => {
  test("returns null for a non-git directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-nogit-"));
    expect(await getGitStatus(root)).toBeNull();
  });

  test("reports branch, dirty count, and null remote for a clean local-only repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);

    const status = await getGitStatus(root);
    expect(status).toEqual({ branch: "main", dirtyCount: 0, ahead: 0, behind: 0, remoteUrl: null });
  });

  test("counts dirty files", async () => {
    const root = mkdtempSync(join(tmpdir(), "zero-git-dirty-"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "a.txt"), "hi");
    await git(root, ["add", "a.txt"]);
    await git(root, ["commit", "-m", "init"]);
    writeFileSync(join(root, "a.txt"), "changed");
    writeFileSync(join(root, "b.txt"), "new");

    const status = await getGitStatus(root);
    expect(status?.dirtyCount).toBe(2);
  });
});
