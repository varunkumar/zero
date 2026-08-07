import { createInterface } from "node:readline/promises";
import { AgentRuntime, ProviderGateway, OpenAICompatProvider, type ChatCapableProvider } from "@zero/core";
import { Workspace } from "../workspace";
import { SessionStore } from "../sessions";
import { LspService } from "../lsp/service";
import { DEFAULT_LSP_SERVERS } from "../lsp/registry";
import { createGraphify } from "../plugins/graphify";
import { createChatTools } from "../chatTools";
import { createAgentRuntimeClient } from "../agentClient";
import { GitCheckpoint } from "../gitCheckpoint";
import { execCommand } from "../execCommand";

export interface AgentCliOpts { providers?: ChatCapableProvider[] }

export async function runAgentCli(argv: string[], root: string, opts: AgentCliOpts = {}): Promise<number> {
  const yes = argv.includes("--yes");
  const forceNonTty = argv.includes("--no-tty-for-test"); // test-only, see agent.test.ts
  const sessionIdx = argv.indexOf("--session");
  const sessionArg = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
  const task = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--session");
  if (!task) { console.error("usage: zero agent \"task description\" [--yes] [--session <id>] [path]"); return 1; }

  const ws = new Workspace(root);
  const sessions = new SessionStore(ws);
  const sessionId = sessionArg ?? (await sessions.create(task.slice(0, 40)));
  const checkpoint = new GitCheckpoint(ws.root);
  const graphify = createGraphify();
  const lsp = new LspService(ws, DEFAULT_LSP_SERVERS, () => {});

  const providers = opts.providers ?? [
    new OpenAICompatProvider({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" }),
  ];
  const tools = createChatTools({
    sessionId, ws, lsp, checkpoint, execCommand,
    graphQuery: (p) => graphify.query(p),
  });
  const runtime = new AgentRuntime({
    providers, tools, client: createAgentRuntimeClient(sessions), workspace: () => ({}),
  });

  const nonInteractive = forceNonTty || !process.stdin.isTTY;
  const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });

  const controller = new AbortController();
  let exitCode = 0;
  try {
    for await (const event of runtime.sendMessage(sessionId, task, controller.signal)) {
      if (event.type === "text") {
        process.stdout.write(event.delta);
      } else if (event.type === "toolCall") {
        console.log(`\n[tool] ${event.call.name} ${JSON.stringify(event.call.args)}`);
      } else if (event.type === "approvalRequest") {
        console.log(`\n[approval] ${event.call.name}\n${event.preview}`);
        if (yes) {
          runtime.resolveApproval(event.call.id, true);
        } else if (nonInteractive) {
          console.error("approval required but stdin is not interactive; pass --yes");
          controller.abort();
          exitCode = 1;
        } else {
          const answer = (await rl!.question("Approve? [y/N] ")).trim().toLowerCase();
          runtime.resolveApproval(event.call.id, answer === "y");
        }
      } else if (event.type === "toolResult") {
        console.log(`[result] ${event.result}`);
      } else if (event.type === "error") {
        console.error(`[error] ${event.message}`);
        exitCode = 1;
      }
    }
  } finally {
    rl?.close();
  }
  console.log(`\nsession: ${sessionId}`);
  return exitCode;
}
