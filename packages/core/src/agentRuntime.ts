import type { ChatCapableProvider, ChatMessage, ChatToolCall, ChatToolSpec, ToolProvider } from "./chatTypes";
import { capToolOutput, needsCompaction, selectForCompaction, COMPACTION_SYSTEM_PROMPT } from "./tokenLedger";
import { buildSystemPrompt, type WorkspaceInfo } from "./systemPrompt";

export type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "toolCall"; call: ChatToolCall }
  | { type: "toolResult"; call: ChatToolCall; result: string }
  | { type: "done"; message: ChatMessage };

export interface AgentRuntimeClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

export interface AgentRuntimeStatus { activeModel: string | null; reason: string | null }

export interface AgentRuntimeOpts {
  providers: ChatCapableProvider[];
  tools: ToolProvider[];
  client: AgentRuntimeClient;
  workspace: () => WorkspaceInfo;
}

const MAX_TOOL_ROUNDS = 8;

export class AgentRuntime {
  #providers: ChatCapableProvider[];
  #tools: ToolProvider[];
  #client: AgentRuntimeClient;
  #workspace: () => WorkspaceInfo;
  #status: AgentRuntimeStatus = { activeModel: null, reason: null };
  #listeners = new Set<(s: AgentRuntimeStatus) => void>();

  constructor(opts: AgentRuntimeOpts) {
    this.#providers = opts.providers;
    this.#tools = opts.tools;
    this.#client = opts.client;
    this.#workspace = opts.workspace;
  }

  status(): AgentRuntimeStatus {
    return this.#status;
  }

  onStatusChange(fn: (s: AgentRuntimeStatus) => void): void {
    this.#listeners.add(fn);
  }

  #setStatus(s: AgentRuntimeStatus): void {
    this.#status = s;
    for (const fn of this.#listeners) fn(s);
  }

  async #pick(): Promise<ChatCapableProvider | null> {
    for (const p of this.#providers) {
      if (await p.available().catch(() => false)) return p;
    }
    return null;
  }

  async *sendMessage(sessionId: string, userText: string, signal: AbortSignal): AsyncIterable<TurnEvent> {
    const provider = await this.#pick();
    if (!provider) {
      this.#setStatus({ activeModel: null, reason: "no chat model available" });
      return;
    }
    this.#setStatus({ activeModel: provider.id, reason: null });

    const loaded = await this.#client.request<{ messages: ChatMessage[] }>("chat/get", { id: sessionId });
    let history = loaded.messages;

    if (needsCompaction(history, provider.capabilities().contextWindowTokens)) {
      history = await this.#compact(provider, history, signal);
    }
    if (signal.aborted) return;

    history = [...history, { role: "user", content: userText, createdAt: Date.now() }];
    const toolSpecs: ChatToolSpec[] = provider.supportsTools()
      ? this.#tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }))
      : [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const system: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({ tools: this.#tools, workspace: this.#workspace() }),
        createdAt: Date.now(),
      };
      let text = "";
      const toolCalls: ChatToolCall[] = [];
      try {
        for await (const delta of provider.chat([system, ...history], toolSpecs, signal)) {
          if (signal.aborted) return;
          if (delta.text) { text += delta.text; yield { type: "text", delta: delta.text }; }
          if (delta.toolCalls) toolCalls.push(...delta.toolCalls);
        }
      } catch (e) {
        if (signal.aborted) return;
        // Provider error (not cancellation): stop cleanly without throwing, matching the "degrade only failing subsystem" constraint
        return;
      }
      if (signal.aborted) return;

      const assistantMsg: ChatMessage = {
        role: "assistant", content: text, toolCalls: toolCalls.length ? toolCalls : undefined, createdAt: Date.now(),
      };
      history = [...history, assistantMsg];

      if (toolCalls.length === 0) {
        await this.#client.request("chat/append", { id: sessionId, messages: history });
        yield { type: "done", message: assistantMsg };
        return;
      }

      for (const call of toolCalls) {
        yield { type: "toolCall", call };
        const tool = this.#tools.find((t) => t.name === call.name);
        const rawResult = tool
          ? await tool.execute(call.args).catch((e: unknown) => `error: ${e instanceof Error ? e.message : String(e)}`)
          : `error: unknown tool ${call.name}`;
        const result = capToolOutput(rawResult);
        history = [...history, { role: "tool", content: result, toolCallId: call.id, toolName: call.name, createdAt: Date.now() }];
        yield { type: "toolResult", call, result };
      }
    }

    await this.#client.request("chat/append", { id: sessionId, messages: history });
    yield { type: "done", message: { role: "assistant", content: "(tool round limit reached)", createdAt: Date.now() } };
  }

  async #compact(provider: ChatCapableProvider, history: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> {
    const { toSummarize, toKeep } = selectForCompaction(history);
    if (toSummarize.length === 0) return history;

    const prompt: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT, createdAt: Date.now() },
      ...toSummarize,
      { role: "user", content: "Summarize the conversation above.", createdAt: Date.now() },
    ];
    let summary = "";
    try {
      for await (const delta of provider.chat(prompt, [], signal)) {
        if (delta.text) summary += delta.text;
      }
    } catch (e) {
      if (signal.aborted) {
        // Cancellation: return original history unchanged
        return history;
      }
      // Provider error: return original history unchanged, don't throw
      return history;
    }
    return [{ role: "system", content: summary, createdAt: Date.now() }, ...toKeep];
  }
}
