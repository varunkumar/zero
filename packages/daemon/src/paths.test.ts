import { expect, test, beforeEach, afterEach } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { zeroHome, sanitizeWorkspacePath, sessionsDir, settingsPath } from "./paths";

let original: string | undefined;
beforeEach(() => { original = process.env.ZERO_HOME; delete process.env.ZERO_HOME; });
afterEach(() => {
  if (original === undefined) delete process.env.ZERO_HOME;
  else process.env.ZERO_HOME = original;
});

test("zeroHome defaults to ~/.zero", () => {
  expect(zeroHome()).toBe(join(homedir(), ".zero"));
});

test("zeroHome respects a ZERO_HOME override", () => {
  process.env.ZERO_HOME = "/tmp/custom-zero-home";
  expect(zeroHome()).toBe("/tmp/custom-zero-home");
});

test("sanitizeWorkspacePath replaces path separators with dashes", () => {
  expect(sanitizeWorkspacePath("/Users/varunkumar/projects/zero")).toBe("-Users-varunkumar-projects-zero");
  expect(sanitizeWorkspacePath("/tmp/x")).toBe("-tmp-x");
});

test("sanitizeWorkspacePath strips colons (Windows drive letters)", () => {
  expect(sanitizeWorkspacePath("C:\\Users\\x")).toBe("-C-Users-x");
});

test("sessionsDir nests under zeroHome/sessions/<sanitized path>", () => {
  process.env.ZERO_HOME = "/tmp/zh";
  expect(sessionsDir("/Users/a/proj")).toBe("/tmp/zh/sessions/-Users-a-proj");
});

test("settingsPath is zeroHome/settings.json", () => {
  process.env.ZERO_HOME = "/tmp/zh";
  expect(settingsPath()).toBe("/tmp/zh/settings.json");
});
