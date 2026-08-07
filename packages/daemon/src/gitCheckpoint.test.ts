import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GitCheckpoint } from "./gitCheckpoint";
import { execCommand } from "./execCommand";

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zero-checkpoint-"));
  await execCommand("git init -q && git config user.email t@t.com && git config user.name t", dir);
  await writeFile(join(dir, "a.txt"), "one\n");
  await writeFile(join(dir, ".gitignore"), ".zero/\n");
  await execCommand("git add -A && git commit -q -m init", dir);
  return dir;
}

test("commits the current working tree onto a shadow branch without touching HEAD", async () => {
  const dir = await initRepo();
  const branchBefore = (await execCommand("git rev-parse --abbrev-ref HEAD", dir)).output.trim();
  const gc = new GitCheckpoint(dir);
  await writeFile(join(dir, "a.txt"), "two\n");

  await gc.checkpoint("session-1", "agent: edit a.txt");

  const branch = await execCommand("git rev-parse --abbrev-ref HEAD", dir);
  expect(branch.output.trim()).toBe(branchBefore); // still on the user's branch, whatever it's named
  const shadowLog = await execCommand("git log --oneline refs/heads/zero/agent-checkpoints/session-1", dir);
  expect(shadowLog.output).toContain("agent: edit a.txt");
  const userStatus = await execCommand("git status --porcelain", dir);
  expect(userStatus.output.trim()).toBe("M a.txt"); // the user's own index/worktree untouched
});

test("a second checkpoint is a child commit of the first on the shadow branch", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await writeFile(join(dir, "a.txt"), "two\n");
  await gc.checkpoint("session-1", "first");
  await writeFile(join(dir, "a.txt"), "three\n");
  await gc.checkpoint("session-1", "second");

  const shadowLog = await execCommand("git log --oneline refs/heads/zero/agent-checkpoints/session-1", dir);
  const lines = shadowLog.output.trim().split("\n");
  expect(lines.length).toBe(3); // init + first + second
});

test("no-op when nothing changed", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await gc.checkpoint("session-1", "noop");
  const exists = await execCommand("git rev-parse --verify refs/heads/zero/agent-checkpoints/session-1", dir);
  expect(exists.exitCode).not.toBe(0); // shadow branch was never created
});

test("degrades to a no-op when the workspace is not a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-checkpoint-nogit-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.txt"), "one\n");
  const gc = new GitCheckpoint(dir);
  await expect(gc.checkpoint("session-1", "should not throw")).resolves.toBeUndefined();
});
