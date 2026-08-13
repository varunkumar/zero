import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";
import { buildToolResponseConstraint, parseNanoToolResponse } from "./nanoTools";

export interface NanoSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal; responseConstraint?: object }): AsyncIterable<string>;
  destroy(): void;
  inputQuota?: number;
}
export interface NanoApi {
  availability(): Promise<"available" | "downloadable" | "downloading" | "unavailable">;
  create(opts?: { monitor?: (m: EventTarget) => void }): Promise<NanoSession>;
}

export async function probeNano(api: NanoApi | undefined): Promise<"ready" | "downloadable" | "unavailable"> {
  if (!api) return "unavailable";
  const state = await api.availability().catch(() => "unavailable" as const);
  if (state === "available") return "ready";
  if (state === "downloadable" || state === "downloading") return "downloadable";
  return "unavailable";
}

export class ChromeNanoProvider implements ChatCapableProvider {
  id = "chrome-nano";
  #session: NanoSession | null = null;
  #sentCount = 0;
  constructor(private api: NanoApi | undefined) {}

  async available(): Promise<boolean> {
    return (await probeNano(this.api)) === "ready";
  }

  capabilities(): ModelCapabilities {
    return {
      id: this.id, supportsFim: false,
      contextWindowTokens: Math.min(this.#session?.inputQuota ?? 6144, 6144),
    };
  }

  async *complete(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    if (!this.api) return;
    this.#session ??= await this.api.create();
    for await (const chunk of this.#session.promptStreaming(prompt, { signal })) {
      if (signal.aborted) return;
      yield chunk;
    }
  }

  supportsTools(): boolean {
    return false;
  }

  /** Reuses the live session across calls, sending only the messages added
   * since the last call (a real conversation, not a re-flattened
   * transcript). A shorter `messages` array than last seen means the
   * conversation reset, so the session is recreated. When `tools` is
   * non-empty, requests Nano's `responseConstraint` constrained decoding
   * (independent of `supportsTools()`, which stays `false` for every other
   * caller) and parses the accumulated output into a single ChatDelta. */
  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.api) return;
    if (messages.length < this.#sentCount) {
      this.#session?.destroy();
      this.#session = null;
      this.#sentCount = 0;
    }
    this.#session ??= await this.api.create();
    const turn = messages.slice(this.#sentCount);
    this.#sentCount = messages.length;
    const prompt = turn.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:";

    if (tools.length > 0) {
      let full = "";
      for await (const chunk of this.#session.promptStreaming(prompt, {
        signal, responseConstraint: buildToolResponseConstraint(tools),
      })) {
        if (signal.aborted) return;
        full += chunk;
      }
      if (signal.aborted) return;
      yield parseNanoToolResponse(full, tools);
      return;
    }

    for await (const chunk of this.#session.promptStreaming(prompt, { signal })) {
      if (signal.aborted) return;
      yield { text: chunk };
    }
  }
}
