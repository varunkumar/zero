import { createInterface } from "node:readline/promises";
import { AgentRuntime, OpenAICompatProvider, type ChatCapableProvider } from "@zero/core";
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

// Flags that take a following value - that value must not be mistaken for a
// positional argument (e.g. `zero --gateway-port 4000` must not treat "4000"
// as the workspace path).
const FLAGS_WITH_VALUE = new Set(["--session", "--gateway-port"]);

/** Parses `--gateway-port <value>` out of argv. Returns `undefined` if the
 * flag is absent, `"invalid"` if present but its value isn't a number (e.g.
 * missing entirely, so `Number(undefined)` is NaN), or the parsed port. */
export function parseGatewayPort(argv: string[]): number | "invalid" | undefined {
  const idx = argv.indexOf("--gateway-port");
  if (idx < 0) return undefined;
  const n = Number(argv[idx + 1]);
  return Number.isNaN(n) ? "invalid" : n;
}

export function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) { i++; continue; } // skip the flag and its value
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

export async function runAgentCli(argv: string[], root: string, opts: AgentCliOpts = {}): Promise<number> {
  const yes = argv.includes("--yes");
  const forceNonTty = argv.includes("--no-tty-for-test"); // test-only, see agent.test.ts
  const sessionIdx = argv.indexOf("--session");
  const sessionArg = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
  const [task] = positionalArgs(argv);
  if (!task) { console.error("usage: zero agent \"task description\" [--yes] [--session <id>] [path]"); return 1; }

  try {
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
      sessionId, root: ws.root, ws, lsp, checkpoint, execCommand,
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
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
