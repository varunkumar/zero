import { resolve } from "node:path";
import { startZero } from "../src/main";
import { runAgentCli, runListModelsCli, positionalArgs, parseGatewayPort, parsePort, parseModel } from "../src/cli/agent";
import { runClaudeCli } from "../src/cli/claude";
import { runTui } from "../src/cli/tui/runTui";
import { VERSION } from "../src/version";

const argv = process.argv.slice(2);

if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`zero ${VERSION}`);
  process.exit(0);
}
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`zero ${VERSION}

usage:
  zero [path] [--model <name>]                      launch the interactive TUI (new session)
  zero --resume [path] [--model <name>]             launch the TUI, pick a session to resume
  zero -p "task" [--yes] [--session <id>] [--model <name>] [path]
                                                    run one task headlessly
  zero --list-models [path]                         print installed Ollama models (* = active)
  zero serve [path] [--port <port>] [--gateway-port <port>]  start the web daemon
  zero claude [path] [--gateway-port <port>]        start the daemon and bridge Claude Code to Gemini Nano
  zero --version                                    print the version`);
  process.exit(0);
}
if (argv[0] === "agent") {
  console.error('zero agent is gone — use: zero -p "task description" [--yes] [--session <id>] [path]');
  process.exit(1);
}

if (argv[0] === "claude") {
  const rest = argv.slice(1);
  const path = positionalArgs(rest)[0];
  const root = resolve(path ?? ".");
  const parsedGatewayPort = parseGatewayPort(rest);
  if (parsedGatewayPort === "invalid") {
    console.error("error: --gateway-port requires a numeric value");
    process.exit(1);
  }
  const exitCode = await runClaudeCli(root, parsedGatewayPort);
  process.exit(exitCode);
} else if (argv[0] === "serve") {
  const rest = argv.slice(1);
  const path = positionalArgs(rest)[0];
  const root = resolve(path ?? ".");
  // `import.meta.url`-relative resolution breaks inside a `bun build
  // --compile` binary (it resolves against a virtual embedded path, not a
  // real one on disk) - ZERO_WEB_DIST lets a compiled sidecar (Zero IDE's
  // Tauri shell) point this at its bundled web/dist copy instead. Unset in
  // the normal `zero serve` dev path, where the relative lookup is correct.
  const webDist = process.env.ZERO_WEB_DIST ?? new URL("../../web/dist", import.meta.url).pathname;
  // Same import.meta.url-relative-resolution problem as ZERO_WEB_DIST above,
  // for the daemon's own plugins/ directory (which holds each plugin's
  // optional ui/dist/index.js bundle, served at GET /plugins/:id/ui.js).
  const pluginsDir = process.env.ZERO_PLUGINS_DIR ?? undefined;
  const parsedGatewayPort = parseGatewayPort(rest);
  if (parsedGatewayPort === "invalid") {
    console.error("error: --gateway-port requires a numeric value");
    process.exit(1);
  }
  const parsedPort = parsePort(rest);
  if (parsedPort === "invalid") {
    console.error("error: --port requires a numeric value");
    process.exit(1);
  }
  const d = await startZero({ root, port: parsedPort, webDist, pluginsDir, gatewayPort: parsedGatewayPort });
  if (rest.includes("--json")) {
    console.log(JSON.stringify({ port: d.port, token: d.token, gatewayInfo: d.gatewayInfo }));
  } else {
    console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
    if (d.gatewayInfo) {
      console.log(`model gateway: http://127.0.0.1:${d.gatewayInfo.port}/v1/messages (ANTHROPIC_API_KEY=${d.gatewayInfo.apiKey})`);
    }
  }
} else if (argv.includes("--list-models")) {
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  process.exit(await runListModelsCli(root));
} else if (argv.includes("-p")) {
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  const exitCode = await runAgentCli(argv, root);
  process.exit(exitCode);
} else {
  const path = positionalArgs(argv)[0];
  const root = resolve(path ?? ".");
  const parsedModel = parseModel(argv);
  if (parsedModel === "invalid") {
    console.error("error: --model requires a model name (see zero --list-models)");
    process.exit(1);
  }
  const sessionIdx = argv.indexOf("--session");
  const sessionId = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
  const start = sessionId
    ? { kind: "session" as const, sessionId }
    : argv.includes("--resume")
      ? { kind: "resume" as const }
      : { kind: "new" as const };
  const exitCode = await runTui(root, start, parsedModel ? { model: parsedModel } : {});
  process.exit(exitCode);
}
