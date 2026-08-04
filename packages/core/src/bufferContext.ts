import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export class BufferContext implements ContextProvider {
  name = "buffer";
  #buffers: { path: string; content: string }[] = [];
  setBuffers(buffers: { path: string; content: string }[]) { this.#buffers = buffers; }
  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    return this.#buffers
      .filter((b) => b.path !== req.path)
      .map((b) => {
        const text = b.content.slice(0, 2000);
        return { source: `buffer:${b.path}`, text, score: 0.5, tokenCost: estimateTokens(text) };
      });
  }
}
