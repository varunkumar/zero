import type { ModelCapabilities, ModelProvider } from "../types";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class OpenAICompatProvider implements ModelProvider {
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
}
