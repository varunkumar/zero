import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";
import { estimateTokens } from "./tokens";

export interface LspContextClient {
  request<R>(method: string, params?: unknown): Promise<R>;
}

/** Cursor position is implicit in a FIM-style `CompletionRequest`: it's
 * exactly where `prefix` ends. Converting to LSP's 0-based line/character
 * needs the prefix's last line only. */
function cursorPosition(prefix: string): { line: number; character: number } {
  const lines = prefix.split("\n");
  return { line: lines.length - 1, character: lines.at(-1)!.length };
}

export class LspContext implements ContextProvider {
  name = "lsp";
  constructor(private client: LspContextClient) {}

  async gather(req: CompletionRequest): Promise<ContextChunk[]> {
    const result = await this.client.request<{ chunks: { text: string; score: number }[] }>(
      "lsp/contextAt", { path: req.path, position: cursorPosition(req.prefix) },
    );
    return result.chunks.map((c) => ({ source: "lsp", text: c.text, score: c.score, tokenCost: estimateTokens(c.text) }));
  }
}
