// packages/daemon/src/cli/runtimeFactory.ts
import { AgentRuntime, type ChatCapableProvider } from "@zero/core";
import { loadOllamaCatalog, providersFromCatalog, writeOllamaModel } from "../ollamaConfig";
import { Workspace } from "../workspace";
import { SessionStore } from "../sessions";
import { LspService } from "../lsp/service";
import { DEFAULT_LSP_SERVERS } from "../lsp/registry";
import { createGraphify } from "../plugins/graphify";
import { createChatTools } from "../chatTools";
import { createAgentRuntimeClient } from "../agentClient";
import { GitCheckpoint } from "../gitCheckpoint";
import { execCommand } from "../execCommand";

export interface CliOpts {
  providers?: ChatCapableProvider[];
  /** `--model` override; persisted when applied via {@link CliContext.setModel}. */
  model?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface CliContext {
  ws: Workspace;
  sessions: SessionStore;
  checkpoint: GitCheckpoint;
  providers: ChatCapableProvider[];
  models: string[];
  activeModel: string | null;
  setModel(name: string): Promise<void>;
  refreshModels(): Promise<void>;
}

/** Session-independent daemon internals shared by every in-process CLI
 * entry point (headless `-p`, the TUI) that needs to run an AgentRuntime
 * without a browser or WebSocket in the loop. */
export async function createCliContext(root: string, opts: CliOpts = {}): Promise<CliContext> {
  const ws = new Workspace(root);
  const sessions = new SessionStore(ws.root);
  const checkpoint = new GitCheckpoint(ws.root);
  const ctx: CliContext = {
    ws, sessions, checkpoint,
    providers: opts.providers ?? [],
    models: [],
    activeModel: null,
    async refreshModels() {
      if (opts.providers) return; // tests inject providers; don't clobber them
      const catalog = await loadOllamaCatalog(ws, opts.fetchImpl ?? fetch, opts.model);
      ctx.models = catalog.models;
      ctx.activeModel = catalog.active;
      ctx.providers = providersFromCatalog(catalog, opts.fetchImpl);
    },
    async setModel(name: string) {
      await writeOllamaModel(ws, name);
      opts.model = name;
      await ctx.refreshModels();
    },
  };
  if (!opts.providers) await ctx.refreshModels();
  else if (opts.model) ctx.activeModel = opts.model;
  return ctx;
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
