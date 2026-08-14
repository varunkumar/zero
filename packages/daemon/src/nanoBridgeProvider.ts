import type { ChatCapableProvider, ChatMessage, ChatToolSpec, ChatDelta, ModelCapabilities } from "@zero/core";
import type { NanoHostRegistry } from "./nanoHost";

/** The daemon-side `ChatCapableProvider` backed by whichever browser tab is
 * currently registered as the Nano host. Wired only into the model
 * gateway's ProviderGateway (never AgentRuntime/chat-turn) — see the M7
 * design spec section 7. */
export class NanoBridgeProvider implements ChatCapableProvider {
  id = "nano-bridge";
  constructor(private registry: NanoHostRegistry) {}

  async available(): Promise<boolean> {
    return this.registry.available();
  }

  capabilities(): ModelCapabilities {
    return { id: this.id, supportsFim: false, contextWindowTokens: 6144 };
  }

  supportsTools(): boolean {
    return true;
  }

  // The model gateway only ever calls chat(); complete() exists to satisfy
  // ModelProvider and is intentionally never used.
  async *complete(): AsyncIterable<string> { /* unused */ }

  chat(messages: ChatMessage[], tools: ChatToolSpec[], signal: AbortSignal): AsyncIterable<ChatDelta> {
    return this.registry.chat(messages, tools, signal);
  }
}
