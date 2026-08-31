// packages/daemon/src/version.ts
import { readFileSync } from "node:fs";

function readVersion(): string {
  // ZERO_VERSION lets a compiled sidecar (bun build --compile) skip the
  // import.meta.url-relative lookup below, which resolves against a
  // virtual embedded path inside a compiled binary, not a real one on
  // disk - the same problem ZERO_WEB_DIST solves in
  // packages/daemon/bin/zero.ts. scripts/package-cli.sh bakes this into
  // the CLI tarball's bin/zero wrapper at package time.
  if (process.env.ZERO_VERSION) return process.env.ZERO_VERSION;
  try {
    const url = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();
