import type { ModelCapabilities, ModelProvider } from "@zero/core";

export interface GatewayCompletionProviderOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class GatewayCompletionProvider implements ModelProvider {
  id = "zero-gateway";
  #baseUrl: string;
  #apiKey: string;
  #fetchImpl: typeof fetch;

  constructor(opts: GatewayCompletionProviderOpts) {
    this.#baseUrl = opts.baseUrl;
    this.#apiKey = opts.apiKey;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
  }

  capabilities(): ModelCapabilities {
    // The gateway wraps every completion as a single chat turn (section 4
    // of the design doc), so the FIM-token prompt style never applies here -
    // buildFimPrompt should use its natural-language fallback framing.
    return { id: this.id, contextWindowTokens: 8192, supportsFim: false };
  }

  async available(): Promise<boolean> {
    try {
      const res = await this.#fetchImpl(`${this.#baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return false;
      const body = (await res.json()) as { provider: string | null };
      return body.provider !== null;
    } catch {
      return false;
    }
  }

  async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    const res = await this.#fetchImpl(`${this.#baseUrl}/v1/complete`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": this.#apiKey },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) throw new Error(`completion failed: ${res.status}`);
    const { text } = (await res.json()) as { text: string };
    if (text) yield text;
  }
}
