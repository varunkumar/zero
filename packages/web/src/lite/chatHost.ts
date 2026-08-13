import type { ChatMessage } from "@zero/protocol";
import {
  AgentRuntime, ChromeNanoProvider, type AgentRuntimeClient, type ChatCapableProvider, type NanoApi, type ToolProvider,
} from "@zero/core";
import type { BrowserFSWorkspace } from "./browserFs";
import { createLiteChatTools } from "./chatTools";
import type { LiteSessionStore } from "./sessionStore";

interface RuntimePool {
  (sessionId: string): Promise<AgentRuntime>;
  /** True if a runtime for this session is already cached (constructed or
   * under construction). Lets chat/status check without triggering a build. */
  has(sessionId: string): boolean;
  /** Remove a session's cached runtime from the pool - called on chat/delete
   * so the pool doesn't retain tools/providers for a deleted session forever. */
  evict(sessionId: string): void;
  /** Drop every cached/in-flight runtime - called on host teardown so a
   * closed connection doesn't keep pooled runtimes (and their tool/provider
   * references) alive. */
  evictAll(): void;
}

/** Session-scoped `AgentRuntime` cache. Memoizes the *construction Promise*,
 * not just the resolved value, so two concurrent callers for a session with
 * no cached runtime yet converge on the same in-flight construction instead
 * of racing to build - and orphan - separate `AgentRuntime` instances.
 * Mirrors `packages/daemon/src/agentRuntimePool.ts`, reimplemented here
 * because `@zero/web` must not import `@zero/daemon`. */
function createRuntimePool(build: (sessionId: string) => Promise<AgentRuntime>): RuntimePool {
  const cache = new Map<string, Promise<AgentRuntime>>();
  const runtimeFor = function runtimeFor(sessionId: string): Promise<AgentRuntime> {
    let rtPromise = cache.get(sessionId);
    if (rtPromise) return rtPromise;
    rtPromise = build(sessionId);
    cache.set(sessionId, rtPromise);
    rtPromise.catch(() => {
      if (cache.get(sessionId) === rtPromise) cache.delete(sessionId);
    });
    return rtPromise;
  } as RuntimePool;
  runtimeFor.has = (sessionId: string) => cache.has(sessionId);
  runtimeFor.evict = (sessionId: string) => { cache.delete(sessionId); };
  runtimeFor.evictAll = () => { cache.clear(); };
  return runtimeFor;
}

async function defaultReadInstructions(fs: Pick<BrowserFSWorkspace, "read">): Promise<string | undefined> {
  for (const path of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      return await fs.read(path);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

export interface LiteChatHostOpts {
  store: LiteSessionStore;
  fs: BrowserFSWorkspace;
  folderName: string;
  nanoApi?: NanoApi;
  notify: (method: string, params: unknown) => void;
  readInstructions?: () => Promise<string | undefined>;
  /** Test-only override for the providers `AgentRuntime` picks from.
   * Production omits this and uses `ChromeNanoProvider` alone. */
  providers?: ChatCapableProvider[];
}

/** Drives an in-browser `AgentRuntime` per Lite chat session: the same
 * `chat/*` RPC surface as the daemon (`packages/daemon/src/main.ts`), minus
 * `run_command` and git checkpointing, backed by `LiteSessionStore` /
 * `BrowserFSWorkspace` instead of a file-backed `SessionStore` / `Workspace`. */
export class LiteChatHost {
  #store: LiteSessionStore;
  #fs: BrowserFSWorkspace;
  #folderName: string;
  #notify: (method: string, params: unknown) => void;
  #readInstructions: () => Promise<string | undefined>;
  #providers: ChatCapableProvider[];
  #instructions: string | undefined;
  #tools: ToolProvider[];
  #activeTurns = new Map<string, { sessionId: string; controller: AbortController }>();
  #runtimeFor: RuntimePool;
  #agentClient: AgentRuntimeClient;

  constructor(opts: LiteChatHostOpts) {
    this.#store = opts.store;
    this.#fs = opts.fs;
    this.#folderName = opts.folderName;
    this.#notify = opts.notify;
    this.#readInstructions = opts.readInstructions ?? (() => defaultReadInstructions(this.#fs));
    this.#providers = opts.providers ?? [new ChromeNanoProvider(opts.nanoApi)];
    this.#tools = createLiteChatTools(this.#fs).map((t) => this.#withChangeNotify(t));

    this.#agentClient = {
      request: async <R>(method: string, params?: unknown): Promise<R> => {
        if (method === "chat/get") {
          const p = params as { id: string };
          const s = await this.#store.get(p.id);
          if (!s) throw new Error(`no such session: ${p.id}`);
          return s as R;
        }
        if (method === "chat/append") {
          const p = params as { id: string; messages: ChatMessage[] };
          await this.#store.append(p.id, p.messages);
          return {} as R;
        }
        throw new Error(`unsupported agent client method: ${method}`);
      },
    };

    this.#runtimeFor = createRuntimePool(async () =>
      new AgentRuntime({
        providers: this.#providers,
        tools: this.#tools,
        client: this.#agentClient,
        workspace: () => ({
          name: this.#folderName,
          root: "browser-fs:" + this.#folderName,
          instructions: this.#instructions,
        }),
      }));
  }

  /** Wraps `fs_write`/`fs_edit` so a successful execute broadcasts
   * `fs/changed` - the same notification `fs/write` and friends emit in
   * `localRpc.ts` - so any UI watching the workspace (e.g. the file tree)
   * picks up edits the agent makes, not just ones the user makes directly. */
  #withChangeNotify(tool: ToolProvider): ToolProvider {
    if (tool.name !== "fs_write" && tool.name !== "fs_edit") return tool;
    return {
      ...tool,
      execute: async (args: unknown) => {
        const result = await tool.execute(args);
        const path = (args as { path?: string }).path;
        if (path) this.#notify("fs/changed", { path });
        return result;
      },
    };
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "chat/create": {
        const p = params as { title?: string } | undefined;
        return { id: await this.#store.create(p?.title) };
      }
      case "chat/list":
        return { sessions: await this.#store.list() };
      case "chat/get": {
        const p = params as { id: string };
        const s = await this.#store.get(p.id);
        if (!s) throw new Error(`no such session: ${p.id}`);
        return s;
      }
      case "chat/append": {
        const p = params as { id: string; messages: ChatMessage[] };
        await this.#store.append(p.id, p.messages);
        return {};
      }
      case "chat/rename": {
        const p = params as { id: string; title: string };
        await this.#store.rename(p.id, p.title);
        return {};
      }
      case "chat/delete": {
        const p = params as { id: string };
        await this.#store.delete(p.id);
        this.#runtimeFor.evict(p.id);
        return {};
      }
      case "chat/turn":
        return this.#turn(params as { sessionId: string; userText: string });
      case "chat/approve": {
        const p = params as { turnId: string; callId: string; approved: boolean };
        const turn = this.#activeTurns.get(p.turnId);
        if (turn) (await this.#runtimeFor(turn.sessionId)).resolveApproval(p.callId, p.approved);
        return {};
      }
      case "chat/abort": {
        const p = params as { turnId: string };
        this.#activeTurns.get(p.turnId)?.controller.abort();
        return {};
      }
      case "chat/status": {
        const p = params as { sessionId: string };
        if (!this.#runtimeFor.has(p.sessionId)) {
          return { activeModel: null, reason: null, usedTokens: null, contextWindowTokens: null };
        }
        return (await this.#runtimeFor(p.sessionId)).status();
      }
      default:
        throw new Error(`unknown chat method: ${method}`);
    }
  }

  /** Tears down this host: aborts every turn still in flight (so an
   * approval granted, or a tool call executing, after the caller has
   * already moved on can't land a write against a workspace the user left)
   * and drops the whole runtime pool. Called from `connectLite`'s `close()`
   * when the user switches folders or the connection is otherwise torn
   * down. Idempotent - safe to call more than once. */
  dispose(): void {
    for (const turn of this.#activeTurns.values()) turn.controller.abort();
    this.#activeTurns.clear();
    this.#runtimeFor.evictAll();
  }

  async #turn(params: { sessionId: string; userText: string }): Promise<{ turnId: string }> {
    // Check-and-reserve must happen synchronously (no `await` between the
    // loop and the `.set()` below) so two chat/turn calls racing for the
    // same session can't both pass the check before either reserves a slot.
    for (const t of this.#activeTurns.values()) {
      if (t.sessionId === params.sessionId) {
        throw new Error("a turn is already in progress for this session");
      }
    }
    const controller = new AbortController();
    const turnId = crypto.randomUUID();
    this.#activeTurns.set(turnId, { sessionId: params.sessionId, controller });

    void (async () => {
      let sawTerminalEvent = false;
      try {
        this.#instructions = await this.#readInstructions().catch(() => undefined);
        const rt = await this.#runtimeFor(params.sessionId);
        for await (const event of rt.sendMessage(params.sessionId, params.userText, controller.signal)) {
          if (event.type === "done" || event.type === "error") sawTerminalEvent = true;
          this.#notify("chat/turnEvent", { turnId, event });
        }
      } catch (e) {
        sawTerminalEvent = true;
        this.#notify("chat/turnEvent", {
          turnId, event: { type: "error", message: e instanceof Error ? e.message : String(e) },
        });
      } finally {
        // AgentRuntime.sendMessage has several early-return points that end
        // the generator without yielding a final done/error event - this
        // only happens when the turn was aborted. Broadcast a synthetic
        // terminal event so every consumer sees a definitive close signal.
        if (!sawTerminalEvent) {
          this.#notify("chat/turnEvent", { turnId, event: { type: "error", message: "aborted" } });
        }
        this.#activeTurns.delete(turnId);
      }
    })();

    return { turnId };
  }
}
