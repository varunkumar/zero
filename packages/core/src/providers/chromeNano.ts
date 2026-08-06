import type { ModelCapabilities, ModelProvider } from "../types";
import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta } from "../chatTypes";

export interface NanoSession {
  promptStreaming(input: string, opts?: { signal?: AbortSignal }): AsyncIterable<string>;
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

  async *chat(messages: ChatMessage[], _tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.api) return;
    this.#session ??= await this.api.create();
    const transcript = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:";
    for await (const chunk of this.#session.promptStreaming(transcript, { signal })) {
      if (signal.aborted) return;
      yield { text: chunk };
    }
  }
}
