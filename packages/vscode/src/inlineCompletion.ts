import type { CompletionEngine } from "@zero/core";

const DEBOUNCE_MS = 150;

export interface PositionLike { line: number; character: number }
export interface TextDocumentLike {
  uri: { fsPath: string };
  getText(): string;
  offsetAt(position: PositionLike): number;
}
export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(fn: () => void): { dispose(): void };
}
export interface InlineCompletionItemLike { insertText: string }
export interface InlineCompletionListLike { items: InlineCompletionItemLike[] }

export interface InlineCompletionDeps {
  sleep?: (ms: number) => Promise<void>;
}

export function createInlineCompletionProvider(engine: CompletionEngine, deps: InlineCompletionDeps = {}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async provideInlineCompletionItems(
      document: TextDocumentLike,
      position: PositionLike,
      _context: unknown,
      token: CancellationTokenLike
    ): Promise<InlineCompletionListLike> {
      await sleep(DEBOUNCE_MS);
      if (token.isCancellationRequested) return { items: [] };

      const text = document.getText();
      const offset = document.offsetAt(position);
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      const result = await engine.complete(
        { path: document.uri.fsPath, prefix: text.slice(0, offset), suffix: text.slice(offset) },
        controller.signal
      );

      if (!result || token.isCancellationRequested) return { items: [] };
      return { items: [{ insertText: result }] };
    },
  };
}
