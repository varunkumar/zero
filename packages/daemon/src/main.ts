import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createDaemon, type DaemonOptions } from "./server";
import { startModelGateway } from "./modelGateway";
import { Workspace } from "./workspace";
import { PtyService } from "./pty";
import { LspService } from "./lsp/service";
import { DEFAULT_LSP_SERVERS, type LspServerConfig } from "./lsp/registry";
import { PluginHost } from "./plugins/host";
import { createGraphify } from "./plugins/graphify";
import { SessionStore } from "./sessions";
import type { ChatMessage } from "@zero/protocol";
import { AgentRuntime, ProviderGateway, OpenAICompatProvider } from "@zero/core";
import { createChatTools } from "./chatTools";
import { createAgentRuntimeClient } from "./agentClient";
import { createRuntimePool } from "./agentRuntimePool";
import { GitCheckpoint } from "./gitCheckpoint";
import { execCommand } from "./execCommand";

export async function startZero(opts: DaemonOptions) {
  const daemon = createDaemon(opts);
  const ws = new Workspace(opts.root);
  const sessions = new SessionStore(ws.root);
  const checkpoint = new GitCheckpoint(opts.root);
  const agentClient = createAgentRuntimeClient(sessions);

  async function buildProviders() {
    const baseUrl = (await ws.readSetting("zero.ollamaUrl")) as string | undefined ?? "http://127.0.0.1:11434/v1";
    const model = (await ws.readSetting("zero.ollamaChatModel")) as string | undefined ?? "qwen2.5-coder:7b";
    // Nano is deliberately excluded here: it requires a browser's
    // window.LanguageModel global, which does not exist in the daemon
    // process. Nano-backed daemon-side runs are M7 (Nano bridge) scope.
    return [new OpenAICompatProvider({ baseUrl, model })];
  }

  const pty = new PtyService(
    opts.root,
    (sessionId, data) => daemon.broadcast("pty/output", { sessionId, data }),
    (sessionId, exitCode) => daemon.broadcast("pty/exit", { sessionId, exitCode }),
  );

  const userServers = (await ws.readSetting("lsp.servers")) as Record<string, LspServerConfig> | undefined;
  const servers = { ...DEFAULT_LSP_SERVERS, ...(userServers ?? {}) };
  const lsp = new LspService(ws, servers,
    (path, diagnostics) => daemon.broadcast("lsp/diagnostics", { path, diagnostics }));

  daemon.rpc.register("fs/read", z.object({ path: z.string() }),
    async (p) => ({ content: await ws.read(p.path) }));
  daemon.rpc.register("fs/write", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await ws.write(p.path, p.content); return {}; });
  daemon.rpc.register("fs/tree", z.object({}).optional().transform(() => ({})),
    async () => ({ entries: await ws.tree() }));
  daemon.rpc.register("fs/search", z.object({ query: z.string(), caseSensitive: z.boolean().optional() }),
    async (p) => ws.search(p.query, p.caseSensitive));
  daemon.rpc.register("settings/get", z.object({ key: z.string() }),
    async (p) => ({ value: await ws.readSetting(p.key) }));
  daemon.rpc.register("settings/set", z.object({ key: z.string(), value: z.unknown() }),
    async (p) => { await ws.writeSetting(p.key, p.value); return {}; });

  daemon.rpc.register("pty/open", z.object({ shell: z.string().optional(), cols: z.number(), rows: z.number() }),
    async (p) => pty.open(p.shell, p.cols, p.rows));
  daemon.rpc.register("pty/input", z.object({ sessionId: z.string(), data: z.string() }),
    async (p) => { pty.input(p.sessionId, p.data); return {}; });
  daemon.rpc.register("pty/resize", z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
    async (p) => { pty.resize(p.sessionId, p.cols, p.rows); return {}; });
  daemon.rpc.register("pty/close", z.object({ sessionId: z.string() }),
    async (p) => { pty.close(p.sessionId); return {}; });
  daemon.rpc.register("pty/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: pty.list() }));

  const lspPosition = z.object({ line: z.number(), character: z.number() });
  daemon.rpc.register("lsp/sync", z.object({ path: z.string(), content: z.string() }),
    async (p) => { await lsp.sync(p.path, p.content); return { failed: await lsp.isFailed(p.path) }; });
  daemon.rpc.register("lsp/hover", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ contents: await lsp.hover(p.path, p.position) }));
  daemon.rpc.register("lsp/definition", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ locations: await lsp.definition(p.path, p.position) }));
  daemon.rpc.register("lsp/contextAt", z.object({ path: z.string(), position: lspPosition }),
    async (p) => ({ chunks: await lsp.contextAt(p.path, p.position) }));

  const chatToolCall = z.object({ id: z.string(), name: z.string(), args: z.unknown() });
  const chatMessage = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCalls: z.array(chatToolCall).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    createdAt: z.number(),
  });
  daemon.rpc.register("chat/create", z.object({ title: z.string().optional() }),
    async (p) => ({ id: await sessions.create(p.title) }));
  daemon.rpc.register("chat/list", z.object({}).optional().transform(() => ({})),
    async () => ({ sessions: await sessions.list() }));
  daemon.rpc.register("chat/get", z.object({ id: z.string() }),
    async (p) => {
      const s = await sessions.get(p.id);
      if (!s) throw new Error(`no such session: ${p.id}`);
      return s;
    });
  daemon.rpc.register("chat/append", z.object({ id: z.string(), messages: z.array(chatMessage) }),
    async (p) => { await sessions.append(p.id, p.messages as ChatMessage[]); return {}; });
  daemon.rpc.register("chat/rename", z.object({ id: z.string(), title: z.string() }),
    async (p) => { await sessions.rename(p.id, p.title); return {}; });
  daemon.rpc.register("chat/delete", z.object({ id: z.string() }),
    async (p) => { await sessions.delete(p.id); runtimeFor.evict(p.id); return {}; });

  const graphify = createGraphify();

  const activeTurns = new Map<string, { sessionId: string; controller: AbortController }>();

  // createRuntimePool memoizes the *construction Promise* per session (not
  // just the resolved value), so concurrent callers for a session with no
  // cached runtime yet converge on the same in-flight construction instead
  // of racing to build - and orphan - separate AgentRuntime instances.
  const runtimeFor = createRuntimePool(async (sessionId) => {
    const providers = await buildProviders();
    const tools = createChatTools({
      sessionId, root: ws.root, ws, lsp, checkpoint, execCommand,
      graphQuery: (p) => graphify.getIndexer() ? graphify.query(p) : { text: "graph not ready" },
    });
    return new AgentRuntime({ providers, tools, client: agentClient, workspace: () => ({}) });
  });

  daemon.rpc.register("chat/turn", z.object({ sessionId: z.string(), userText: z.string() }),
    async (p) => {
      // Check-and-reserve must happen synchronously (no `await` between the
      // loop and the `.set()` below) so two chat/turn calls racing for the
      // same session can't both pass the check before either reserves a
      // slot - otherwise both would proceed concurrently against the same
      // AgentRuntime and their final chat/append calls would clobber each
      // other's persisted history (last-writer-wins).
      for (const t of activeTurns.values()) {
        if (t.sessionId === p.sessionId) {
          throw new Error("a turn is already in progress for this session");
        }
      }
      const controller = new AbortController();
      const turnId = crypto.randomUUID();
      activeTurns.set(turnId, { sessionId: p.sessionId, controller });
      (async () => {
        let sawTerminalEvent = false;
        try {
          const rt = await runtimeFor(p.sessionId);
          for await (const event of rt.sendMessage(p.sessionId, p.userText, controller.signal)) {
            if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
            daemon.broadcast("chat/turnEvent", { turnId, event });
          }
        } catch (e) {
          // Defense-in-depth: AgentRuntime.sendMessage never throws today
          // (it degrades to an "error" TurnEvent internally), but that's an
          // implicit invariant living in another file - don't let a future
          // change there silently drop the turn instead of surfacing it.
          sawTerminalEvent = true;
          daemon.broadcast("chat/turnEvent", {
            turnId, event: { type: "error", message: e instanceof Error ? e.message : String(e) },
          });
        } finally {
          // AgentRuntime.sendMessage has several `if (signal.aborted) return;`
          // early-return points that end the generator without yielding a
          // final "done"/"error" event - this only happens when the turn was
          // aborted. Broadcast a synthetic terminal event here so every
          // consumer of the wire protocol (not just ChatPanel, which has its
          // own local abort-handling workaround) sees a definitive close
          // signal instead of the stream just silently stopping.
          if (!sawTerminalEvent) {
            daemon.broadcast("chat/turnEvent", { turnId, event: { type: "error", message: "aborted" } });
          }
          activeTurns.delete(turnId);
        }
      })();
      return { turnId };
    });
  daemon.rpc.register("chat/approve", z.object({ turnId: z.string(), callId: z.string(), approved: z.boolean() }),
    async (p) => {
      const turn = activeTurns.get(p.turnId);
      if (!turn) return {};
      (await runtimeFor(turn.sessionId)).resolveApproval(p.callId, p.approved);
      return {};
    });
  daemon.rpc.register("chat/abort", z.object({ turnId: z.string() }),
    async (p) => { activeTurns.get(p.turnId)?.controller.abort(); return {}; });
  daemon.rpc.register("chat/status", z.object({ sessionId: z.string() }),
    async (p) => {
      // Status checks must not be a side-effecting construction trigger: the
      // web ChatPanel calls chat/status on every session switch, so
      // unconditionally calling runtimeFor here would populate the pool for
      // every session ever viewed (including deleted ones) and grow it
      // unboundedly over a long-running daemon. A session gets a real
      // runtime the first time chat/turn actually runs for it - that's the
      // correct trigger point. Until then, report the neutral "no chat
      // model" status without building anything.
      if (!runtimeFor.has(p.sessionId)) return { activeModel: null, reason: null };
      return (await runtimeFor(p.sessionId)).status();
    });

  const host = new PluginHost({
    rpc: daemon.rpc,
    workspace: ws,
    root: opts.root,
    broadcast: (m, p) => daemon.broadcast(m, p),
  });
  host.registerHostRpcs();
  // Fire-and-forget activation; tests can await pluginsReady.
  // Failures degrade Graphify only (host catches factory/activate errors).
  const pluginsReady = host.activateBuiltins([graphify.factory]);

  const unwatch = ws.watch((path) => {
    daemon.broadcast("fs/changed", { path });
    try {
      graphify.getIndexer()?.onFileChanged(path);
    } catch {
      // Graphify reindex must not break fs broadcast
    }
  });

  let gatewayInfo: { port: number; apiKey: string } | undefined;
  let stopGateway: (() => void) | undefined;
  if (opts.gatewayPort !== undefined) {
    const providers = await buildProviders();
    const gw = startModelGateway({ port: opts.gatewayPort, gateway: new ProviderGateway(providers) });
    gatewayInfo = { port: gw.port, apiKey: gw.apiKey };
    stopGateway = gw.stop;
    await mkdir(join(opts.root, ".zero"), { recursive: true })
      .then(() => writeFile(join(opts.root, ".zero", "gateway-key"), gw.apiKey, { encoding: "utf8", mode: 0o600 }))
      .catch((e) => console.warn(`zero: failed to write .zero/gateway-key (${e instanceof Error ? e.message : String(e)})`));
  }

  const stop = daemon.stop;
  return {
    ...daemon,
    pluginsReady,
    gatewayInfo,
    stop: () => {
      unwatch();
      pty.closeAll();
      lsp.dispose();
      stopGateway?.();
      stop();
    },
  };
}
