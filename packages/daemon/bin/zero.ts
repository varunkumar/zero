import { resolve } from "node:path";
import { startZero } from "../src/main";
import { runAgentCli, positionalArgs, parseGatewayPort } from "../src/cli/agent";

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "agent") {
  const path = positionalArgs(rest)[1]; // [0] is the task, [1] (if present) is the optional path
  const root = resolve(path ?? ".");
  const exitCode = await runAgentCli(rest, root);
  process.exit(exitCode);
} else {
  const argv = process.argv.slice(2);
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  const webDist = new URL("../../web/dist", import.meta.url).pathname;
  const parsedGatewayPort = parseGatewayPort(argv);
  if (parsedGatewayPort === "invalid") {
    console.error("error: --gateway-port requires a numeric value");
    process.exit(1);
  }
  const gatewayPort = parsedGatewayPort;
  const d = await startZero({ root, port: 4820, webDist, gatewayPort });
  console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
  if (d.gatewayInfo) {
    console.log(`model gateway: http://127.0.0.1:${d.gatewayInfo.port}/v1/messages (ANTHROPIC_API_KEY=${d.gatewayInfo.apiKey})`);
  }
}
