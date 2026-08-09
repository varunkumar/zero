import { resolve } from "node:path";
import { startZero } from "../src/main";
import { runAgentCli, positionalArgs, parseGatewayPort } from "../src/cli/agent";
import { runTui } from "../src/cli/tui/runTui";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`usage:
  zero [path]                                       launch the interactive TUI (new session)
  zero --resume [path]                              launch the TUI, pick a session to resume
  zero -p "task" [--yes] [--session <id>] [path]    run one task headlessly
  zero serve [path] [--gateway-port <port>]         start the web daemon`);
  process.exit(0);
}
if (argv[0] === "agent") {
  console.error('zero agent is gone — use: zero -p "task description" [--yes] [--session <id>] [path]');
  process.exit(1);
}

if (argv[0] === "serve") {
  const rest = argv.slice(1);
  const path = positionalArgs(rest)[0];
  const root = resolve(path ?? ".");
  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const parsedGatewayPort = parseGatewayPort(rest);
  if (parsedGatewayPort === "invalid") {
    console.error("error: --gateway-port requires a numeric value");
    process.exit(1);
  }
  const d = await startZero({ root, port: 4820, webDist, gatewayPort: parsedGatewayPort });
  console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
  if (d.gatewayInfo) {
    console.log(`model gateway: http://127.0.0.1:${d.gatewayInfo.port}/v1/messages (ANTHROPIC_API_KEY=${d.gatewayInfo.apiKey})`);
  }
} else if (argv.includes("-p")) {
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  const exitCode = await runAgentCli(argv, root);
  process.exit(exitCode);
} else {
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  const start = argv.includes("--resume") ? { kind: "resume" as const } : { kind: "new" as const };
  const exitCode = await runTui(root, start);
  process.exit(exitCode);
}
