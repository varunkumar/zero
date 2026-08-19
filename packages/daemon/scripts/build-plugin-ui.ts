import { readdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const pluginsDir = new URL("../src/plugins", import.meta.url).pathname;

async function main() {
  const ids = await readdir(pluginsDir, { withFileTypes: true });
  let built = 0;
  for (const entry of ids) {
    if (!entry.isDirectory()) continue;
    const entryPoint = join(pluginsDir, entry.name, "ui", "src", "index.tsx");
    const file = Bun.file(entryPoint);
    if (!(await file.exists())) continue;
    const outdir = join(pluginsDir, entry.name, "ui", "dist");
    const result = await Bun.build({
      entrypoints: [entryPoint],
      outdir,
      naming: "index.js",
      target: "browser",
      format: "esm",
    });
    if (!result.success) {
      for (const log of result.logs) console.error(log);
      throw new Error(`build failed for plugin UI: ${entry.name}`);
    }
    built++;
    console.log(`built ${entry.name}/ui/dist/index.js`);
  }
  console.log(`${built} plugin UI bundle(s) built`);
}

void main();
