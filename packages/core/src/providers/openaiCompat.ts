import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OpenAICompatProvider implements ChatCapableProvider {
  id: string;
  #opts: { baseUrl: string; model: string; contextWindowTokens: number; fetchImpl: FetchLike };

  constructor(opts: { baseUrl: string; model: string; contextWindowTokens?: number; fetchImpl?: FetchLike }) {
    this.id = `openai:${opts.model}`;
    this.#opts = { contextWindowTokens: 8192, fetchImpl: fetch, ...opts };
  }

  capabilities(): ModelCapabilities {
    return { id: this.id, contextWindowTokens: this.#opts.contextWindowTokens, supportsFim: true };
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/models`,
        { signal: AbortSignal.timeout(1000) });
      return res.ok;
    } catch { return false; }
  }

  async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/completions`, {
      method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.#opts.model, prompt, stream: true, max_tokens: 256 }),
    });
    if (!res.ok || !res.body) throw new Error(`completion failed: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        const text = JSON.parse(payload).choices?.[0]?.text;
        if (text) yield text;
      }
    }
  }

  supportsTools(): boolean {
    return true;
  }

  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    const body: Record<string, unknown> = {
      model: this.#opts.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
      })),
    };
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } }));
    }

    // Tool-call arguments stream as accumulating JSON-string fragments;
    // reassembling that incrementally isn't worth the complexity for
    // typically-short tool calls. Non-streaming whenever tools are offered;
    // stream plain text turns for responsiveness otherwise.
    if (tools.length) {
      const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/chat/completions`, {
        method: "POST", signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream: false }),
      });
      if (!res.ok) throw new Error(`chat failed: ${res.status}`);
      const data = await res.json() as {
        choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const message = data.choices[0]?.message;
      const toolCalls = message?.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") }));
      yield { text: message?.content ?? undefined, toolCalls };
      return;
    }

    const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/chat/completions`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        const text = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (text) yield { text };
      }
    }
  }
}
