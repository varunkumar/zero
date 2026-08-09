import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execCommand } from "./execCommand";

test("captures stdout and a zero exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  const { exitCode, output } = await execCommand("echo hello", dir);
  expect(exitCode).toBe(0);
  expect(output.trim()).toBe("hello");
});

test("captures a non-zero exit code and stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  const { exitCode, output } = await execCommand("echo oops 1>&2; exit 3", dir);
  expect(exitCode).toBe(3);
  expect(output.trim()).toBe("oops");
});

test("runs in the given cwd", async () => {
  let dir = await mkdtemp(join(tmpdir(), "zero-exec-"));
  dir = await realpath(dir);
  const { output } = await execCommand("pwd", dir);
  expect(output.trim()).toBe(dir);
});
