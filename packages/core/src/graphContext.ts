import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export interface GraphContextClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

function cursorPosition(prefix: string): { line: number; character: number } {
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export class GraphContext implements ContextProvider {
  name = "graph";
  constructor(private client: GraphContextClient) {}

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    try {
      const result = await this.client.request<{
        chunks: { text: string; score: number; source?: string }[];
        ready: boolean;
      }>("graph/contextAt", {
        path: req.path,
        position: cursorPosition(req.prefix),
        maxChunks: 6,
      });
      if (!result.ready) return [];
      return result.chunks.map((c) => ({
        source: c.source ?? "graph",
        text: c.text,
        score: c.score,
        tokenCost: estimateTokens(c.text),
      }));
    } catch {
      return [];
    }
  }
}
