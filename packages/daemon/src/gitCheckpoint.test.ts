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

test("second checkpoint with no changes respects no-op guard (index file isolation)", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);
  await writeFile(join(dir, "a.txt"), "two\n");
  await gc.checkpoint("session-1", "first");

  // Reset working tree to clean
  await writeFile(join(dir, "a.txt"), "one\n");

  // Second checkpoint with no changes - should be a no-op
  await gc.checkpoint("session-1", "noop");

  const shadowLog = await execCommand("git log --oneline refs/heads/zero/agent-checkpoints/session-1", dir);
  const lines = shadowLog.output.trim().split("\n");
  expect(lines.length).toBe(2); // init + first, NOT three with an extra noop commit
  const userStatus = await execCommand("git status --porcelain", dir);
  expect(userStatus.output.trim()).toBe(""); // no leftover files from index operations in .git/
});

test("never stages .zero/ into the shadow branch, even when gateway-key and session transcripts exist", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);

  // Simulate a live gateway credential and chat transcripts sitting in
  // .zero/ - this repo's own .gitignore happens to exclude .zero/, but an
  // arbitrary user workspace has no such guarantee, so the exclusion must
  // be enforced by GitCheckpoint itself, not inherited from the workspace's
  // .gitignore.
  await mkdir(join(dir, ".zero", "sessions"), { recursive: true });
  await writeFile(join(dir, ".zero", "gateway-key"), "super-secret-live-key");
  await writeFile(join(dir, ".zero", "sessions", "s1.json"), JSON.stringify({ messages: ["hi"] }));
  await writeFile(join(dir, "a.txt"), "two\n");

  await gc.checkpoint("session-1", "agent: edit a.txt");

  const shadowRef = "refs/heads/zero/agent-checkpoints/session-1";
  const showStat = await execCommand(`git show --stat ${shadowRef}`, dir);
  expect(showStat.output).not.toContain(".zero");

  const lsTree = await execCommand(`git ls-tree -r --name-only ${shadowRef}`, dir);
  expect(lsTree.output.split("\n")).not.toContain(".zero/gateway-key");
  expect(lsTree.output).not.toContain(".zero");
});

test("a workspace where only .zero/ changed is treated as a no-op, not a spurious checkpoint", async () => {
  const dir = await initRepo();
  const gc = new GitCheckpoint(dir);

  await mkdir(join(dir, ".zero"), { recursive: true });
  await writeFile(join(dir, ".zero", "gateway-key"), "super-secret-live-key");

  await gc.checkpoint("session-1", "should be a no-op");

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
