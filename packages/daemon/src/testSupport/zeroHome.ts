import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";

/** Points ZERO_HOME at a fresh tmpdir for each test and restores the prior
 * value afterward. Any test that (directly or transitively, e.g. via
 * SessionStore/Workspace settings/startZero/runAgentCli) touches ~/.zero
 * must call this once at the top of the file — otherwise it reads/writes
 * the developer's real home directory. */
export function useTempZeroHome(): void {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.ZERO_HOME;
    process.env.ZERO_HOME = mkdtempSync(join(tmpdir(), "zero-home-"));
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ZERO_HOME;
    else process.env.ZERO_HOME = original;
  });
}
