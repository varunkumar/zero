import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function httpError(action: string, res: Response): Promise<Error> {
  let detail = "";
  try { detail = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 400); } catch { /* body unreadable */ }
  return new Error(`${action} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
}

type FallbackToolCall = { id: string; name: string; args: Record<string, unknown> };

// Scans for top-level `{...}` substrings using brace balancing, so a tool
// call embedded anywhere in noisy text (special tokens, stray prose, a
// repeated echo of the same call, code-fence markers) can still be found,
// rather than requiring the entire string to be exactly one JSON value.
function extractJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
      else if (depth < 0) depth = 0; // unbalanced closer, e.g. stray text - resync
    }
  }
  return out;
}

// Some Ollama models (e.g. qwen2.5-coder) are instructed by their chat
// template to wrap tool calls in <tool_call>{...}</tool_call> so Ollama can
// lift them into the structured `tool_calls` field, but don't reliably follow
// that format - observed variants include bare JSON with no wrapper, a stray
// `<|im_start|>` token before the JSON, and the same call echoed twice (once
// raw, once in a ```json fence). Recover the call so tool use still works
// against those models rather than the JSON being echoed to the user as if
// it were a reply.
function parseFallbackToolCalls(content: string | null | undefined, toolNames: Set<string>): FallbackToolCall[] | undefined {
  if (!content) return undefined;
  const tagMatches = [...content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
  const candidates = (tagMatches.length ? tagMatches.map((m) => m[1]) : [content]).flatMap(extractJsonObjects);
  const calls: FallbackToolCall[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== "string" || !toolNames.has(parsed.name)) continue;
      const args = (parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : {}) as Record<string, unknown>;
      const dedupeKey = `${parsed.name}:${JSON.stringify(args)}`;
      if (seen.has(dedupeKey)) continue; // model echoed the same call more than once
      seen.add(dedupeKey);
      calls.push({ id: `fallback-${calls.length}-${Date.now()}`, name: parsed.name, args });
    } catch {
      // Not a tool call - ordinary text content, leave it alone.
    }
  }
  return calls.length ? calls : undefined;
}

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
    if (!res.ok || !res.body) throw await httpError("completion", res);
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
      if (!res.ok) throw await httpError("chat", res);
      const data = await res.json() as {
        choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const message = data.choices[0]?.message;
      const toolCalls = message?.tool_calls?.map((c) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments || "{}") }))
        ?? parseFallbackToolCalls(message?.content, new Set(tools.map((t) => t.name)));
      yield { text: toolCalls ? undefined : message?.content ?? undefined, toolCalls };
      return;
    }

    const res = await this.#opts.fetchImpl(`${this.#opts.baseUrl}/chat/completions`, {
      method: "POST", signal, headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok || !res.body) throw await httpError("chat", res);
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
