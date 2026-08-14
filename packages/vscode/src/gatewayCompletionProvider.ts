import type { ModelCapabilities, ModelProvider } from "@zero/core";

export interface GatewayCompletionProviderOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  /** Called with a diagnostic message when complete() fails, before the error is re-thrown. */
  onError?: (message: string) => void;
}

export class GatewayCompletionProvider implements ModelProvider {
  id = "zero-gateway";
  #baseUrl: string;
  #apiKey: string;
  #fetchImpl: typeof fetch;
  #onError?: (message: string) => void;

  constructor(opts: GatewayCompletionProviderOpts) {
    this.#baseUrl = opts.baseUrl;
    this.#apiKey = opts.apiKey;
    this.#fetchImpl = opts.fetchImpl ?? fetch;
    this.#onError = opts.onError;
  }

  capabilities(): ModelCapabilities {
    // The gateway wraps every completion as a single chat turn (section 4
    // of the design doc), so the FIM-token prompt style never applies here -
    // buildFimPrompt should use its natural-language fallback framing.
    return { id: this.id, contextWindowTokens: 8192, supportsFim: false };
  }

  async available(): Promise<boolean> {
    try {
      // 3s, not 1s: /health probes every configured provider serially,
      // including Ollama's /models check which itself has a 1s timeout
      // (packages/core/src/providers/openaiCompat.ts). This isn't a hot
      // path - CompletionEngine already caches availability for 30s.
      const res = await this.#fetchImpl(`${this.#baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
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
    if (!res.ok) {
      const message = `Zero completion request failed: ${res.status} ${res.statusText}`;
      this.#onError?.(message);
      throw new Error(`completion failed: ${res.status}`);
    }
    const { text } = (await res.json()) as { text: string };
    const stripped = stripCodeFence(text);
    if (stripped) yield stripped;
  }
}

// Chat models asked to "continue this code" often wrap the reply in a
// fenced markdown block (optionally with a language tag) and/or trailing
// prose. Strip a leading/trailing fence so ghost text is just code; leave
// the text unchanged if it doesn't start with a fence or has no matching
// closing fence.
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline === -1) return text;

    const closingIndex = trimmed.lastIndexOf("```");
    if (closingIndex <= firstNewline) return text; // no matching closing fence

    return trimmed.slice(firstNewline + 1, closingIndex).replace(/\n$/, "");
  }

  // The model sometimes answers with real code followed by a fenced
  // "example usage" block (see gatewayCompletionProvider.test.ts). A fence
  // starting on its own line after real content is never part of the
  // completion itself, so drop it and everything after rather than
  // inlining literal backtick markers into the editor.
  const appendedFence = trimmed.indexOf("\n```");
  if (appendedFence !== -1) {
    return trimmed.slice(0, appendedFence);
  }

  return text;
}
