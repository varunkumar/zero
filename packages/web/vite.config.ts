import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Baked in at build time (not read at runtime) so it works identically in
// Zero Lite's static build and packages/daemon's compiled sidecar - runtime
// import.meta.url-relative resolution breaks inside a `bun build --compile`
// binary (see ZERO_PTY_NODE_BIN/ZERO_WEB_DIST in packages/daemon for the
// same class of bug), but Vite's `define` substitutes this at build time,
// before that binary exists.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __ZERO_VERSION__: JSON.stringify(rootPkg.version),
  },
});
