import { resolve } from "node:path";
import { startZero } from "../src/main";
import { runAgentCli } from "../src/cli/agent";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "agent") {
  const pathArg = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--session");
  const root = resolve(pathArg ?? ".");
  const exitCode = await runAgentCli(rest, root);
  process.exit(exitCode);
} else {
  const root = resolve(cmd ?? ".");
  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const d = await startZero({ root, port: 4820, webDist });
  console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
}
