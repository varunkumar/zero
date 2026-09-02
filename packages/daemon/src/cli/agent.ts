// packages/daemon/src/cli/agent.ts
import { createInterface } from "node:readline/promises";
import { createCliContext, createRuntimeForSession, type CliOpts } from "./runtimeFactory";
import { formatToolResultLine } from "./toolLine";

export type AgentCliOpts = CliOpts;

// Flags that take a following value - that value must not be mistaken for a
// positional argument (e.g. `zero --gateway-port 4000` must not treat "4000"
// as the workspace path).
const FLAGS_WITH_VALUE = new Set(["-p", "--session", "--gateway-port", "--port", "--model"]);

/** Parses a `<flag> <value>` pair out of argv. Returns `undefined` if the
 * flag is absent, `"invalid"` if present but its value isn't a number (e.g.
 * missing entirely, so `Number(undefined)` is NaN), or the parsed port. */
function parsePortFlag(argv: string[], flag: string): number | "invalid" | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const n = Number(argv[idx + 1]);
  return Number.isNaN(n) ? "invalid" : n;
}

/** Parses `--gateway-port <value>` out of argv. See {@link parsePortFlag}. */
export function parseGatewayPort(argv: string[]): number | "invalid" | undefined {
  return parsePortFlag(argv, "--gateway-port");
}

/** Parses `--port <value>` out of argv. See {@link parsePortFlag}. */
export function parsePort(argv: string[]): number | "invalid" | undefined {
  return parsePortFlag(argv, "--port");
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

/** Parses `--model <name>`. Returns `undefined` if absent, `"invalid"` if
 * present without a following non-flag value. */
export function parseModel(argv: string[]): string | "invalid" | undefined {
  const idx = argv.indexOf("--model");
  if (idx < 0) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("-")) return "invalid";
  return value;
}

export async function runListModelsCli(root: string, opts: AgentCliOpts = {}): Promise<number> {
  try {
    const ctx = await createCliContext(root, opts);
    if (ctx.models.length === 0) {
      console.error("no Ollama models found. is ollama running? try: ollama pull <name>");
      return 1;
    }
    for (const name of ctx.models) {
      const mark = name === ctx.activeModel ? "*" : " ";
      console.log(`${mark} ${name}`);
    }
    return 0;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

export async function runAgentCli(argv: string[], root: string, opts: AgentCliOpts = {}): Promise<number> {
  const yes = argv.includes("--yes");
  const forceNonTty = argv.includes("--no-tty-for-test"); // test-only, see agent.test.ts
  const sessionIdx = argv.indexOf("--session");
  const sessionArg = sessionIdx >= 0 ? argv[sessionIdx + 1] : undefined;
  const pIdx = argv.indexOf("-p");
  const task = pIdx >= 0 ? argv[pIdx + 1] : undefined;
  if (!task) { console.error('usage: zero -p "task description" [--yes] [--session <id>] [--model <name>] [path]'); return 1; }

  const parsedModel = parseModel(argv);
  if (parsedModel === "invalid") {
    console.error("error: --model requires a model name (see zero --list-models)");
    return 1;
  }

  try {
    const ctx = await createCliContext(root, { ...opts, model: parsedModel ?? opts.model });
    if (parsedModel && ctx.activeModel !== parsedModel && !(ctx.activeModel?.startsWith(`${parsedModel}:`))) {
      const installed = ctx.models.length ? ctx.models.join(", ") : "(none — is Ollama running?)";
      console.error(`error: model ${parsedModel} is not installed. available: ${installed}`);
      return 1;
    }
    const sessionId = sessionArg ?? (await ctx.sessions.create(task.slice(0, 40)));
    const runtime = createRuntimeForSession(ctx, sessionId);

    const nonInteractive = forceNonTty || !process.stdin.isTTY;
    const rl = nonInteractive ? null : createInterface({ input: process.stdin, output: process.stdout });

    const controller = new AbortController();
    let exitCode = 0;
    try {
      for await (const event of runtime.sendMessage(sessionId, task, controller.signal)) {
        if (event.type === "text") {
          process.stdout.write(event.delta);
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
          // Collapsed into one line, same as the TUI transcript - the raw
          // call args + raw result used to print as two separate, often
          // very long lines (full JSON args, untruncated result).
          console.log(`\n${formatToolResultLine(event.call, event.result)}`);
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
