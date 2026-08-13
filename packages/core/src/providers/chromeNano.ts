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
  /** Fingerprint of the first `#sentCount` messages as they looked when they
   * were sent, so a *different* conversation of equal-or-greater length is
   * detected as a reset too (the bridge is a shared endpoint: whichever
   * conversation Claude Code sends next may be unrelated to the last one). */
  #sentFingerprint = "";
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

  #fingerprint(messages: ChatMessage[]): string {
    return messages.map((m) => `${m.role}:${m.content}`).join("\n");
  }

  /** Reuses the live session across calls, sending only the messages added
   * since the last call (a real conversation, not a re-flattened
   * transcript). A shorter `messages` array than last seen, or a leading
   * slice that no longer matches what was actually sent, means the
   * conversation reset or was replaced, so the session is recreated. When `tools` is
   * non-empty, requests Nano's `responseConstraint` constrained decoding
   * (independent of `supportsTools()`, which stays `false` for every other
   * caller) and parses the accumulated output into a single ChatDelta. */
  async *chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    if (!this.api) return;
    if (messages.length < this.#sentCount
      || this.#fingerprint(messages.slice(0, this.#sentCount)) !== this.#sentFingerprint) {
      this.#session?.destroy();
      this.#session = null;
      this.#sentCount = 0;
      this.#sentFingerprint = "";
    }
    const session = this.#session ??= await this.api.create();
    const turn = messages.slice(this.#sentCount);
    const prompt = turn.map((m) => `${m.role}: ${m.content}`).join("\n\n") + "\n\nassistant:";

    // Committed only once the turn has actually been streamed: an abort or a
    // throw mid-stream leaves the session in an unknown state, so the
    // counter must not claim those messages were delivered. The half-fed
    // session is dropped so the next call rebuilds cleanly.
    let committed = false;
    try {
      if (tools.length > 0) {
        let full = "";
        for await (const chunk of session.promptStreaming(prompt, {
          signal, responseConstraint: buildToolResponseConstraint(tools),
        })) {
          if (signal.aborted) return;
          full += chunk;
        }
        if (signal.aborted) return;
        this.#sentCount = messages.length;
        this.#sentFingerprint = this.#fingerprint(messages);
        committed = true;
        yield parseNanoToolResponse(full, tools);
        return;
      }

      for await (const chunk of session.promptStreaming(prompt, { signal })) {
        if (signal.aborted) return;
        yield { text: chunk };
      }
      this.#sentCount = messages.length;
      this.#sentFingerprint = this.#fingerprint(messages);
      committed = true;
    } finally {
      if (!committed && this.#session === session) {
        session.destroy();
        this.#session = null;
        this.#sentCount = 0;
        this.#sentFingerprint = "";
      }
    }
  }
}
