import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(desktopDir, "../..");

function jsonVersion(rel: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as { version: string };
  return pkg.version;
}

test("Cargo.toml and tauri.conf.json stay on the same version as root package.json", () => {
  const expected = jsonVersion("package.json");
  expect(jsonVersion("packages/desktop/package.json")).toBe(expected);
  expect(jsonVersion("packages/desktop/src-tauri/tauri.conf.json")).toBe(expected);
  expect(jsonVersion("packages/vscode/package.json")).toBe(expected);

  const cargo = readFileSync(join(repoRoot, "packages/desktop/src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version = "([0-9]+\.[0-9]+\.[0-9]+)"/m)?.[1];
  expect(cargoVersion).toBe(expected);

  const lock = readFileSync(join(repoRoot, "packages/desktop/src-tauri/Cargo.lock"), "utf8");
  const lockVersion = lock.match(/name = "app"\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"/)?.[1];
  expect(lockVersion).toBe(expected);
});
