// packages/daemon/src/cli/runtimeFactory.ts
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

export interface CliOpts { providers?: ChatCapableProvider[] }

export interface CliContext {
  ws: Workspace;
  sessions: SessionStore;
  checkpoint: GitCheckpoint;
  providers: ChatCapableProvider[];
}

/** Session-independent daemon internals shared by every in-process CLI
 * entry point (headless `-p`, the TUI) that needs to run an AgentRuntime
 * without a browser or WebSocket in the loop. */
export function createCliContext(root: string, opts: CliOpts = {}): CliContext {
  const ws = new Workspace(root);
  const sessions = new SessionStore(ws.root);
  const checkpoint = new GitCheckpoint(ws.root);
  const providers = opts.providers ?? [
    new OpenAICompatProvider({ baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5-coder:7b" }),
  ];
  return { ws, sessions, checkpoint, providers };
}

/** Builds an AgentRuntime bound to one session's tools. Call once per
 * session per CLI process. */
export function createRuntimeForSession(ctx: CliContext, sessionId: string): AgentRuntime {
  const graphify = createGraphify();
  const lsp = new LspService(ctx.ws, DEFAULT_LSP_SERVERS, () => {});
  const tools = createChatTools({
    sessionId, root: ctx.ws.root, ws: ctx.ws, lsp, checkpoint: ctx.checkpoint, execCommand,
    graphQuery: (p) => graphify.query(p),
  });
  return new AgentRuntime({
    providers: ctx.providers, tools, client: createAgentRuntimeClient(ctx.sessions), workspace: () => ({}),
  });
}
