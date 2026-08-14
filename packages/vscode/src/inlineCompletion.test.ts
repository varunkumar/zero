import { expect, test } from "bun:test";
import { CompletionEngine, BufferContext, type ModelProvider, type ModelCapabilities } from "@zero/core";
import { createInlineCompletionProvider, type TextDocumentLike, type CancellationTokenLike } from "./inlineCompletion";

function stubModel(text: string | null): ModelProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: (): ModelCapabilities => ({ id: "stub", contextWindowTokens: 1000, supportsFim: false }),
    async *complete() { if (text !== null) yield text; },
  };
}

function fakeDocument(text: string): TextDocumentLike {
  return {
    uri: { fsPath: "/proj/a.ts" },
    getText: () => text,
    offsetAt: (pos) => pos.character,
  };
}

function fakeToken(): CancellationTokenLike & { cancel(): void } {
  let cancelled = false;
  const handlers: (() => void)[] = [];
  return {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested(fn) { handlers.push(fn); return { dispose() {} }; },
    cancel() { cancelled = true; handlers.forEach((h) => h()); },
  };
}

test("returns a completion after the debounce window", async () => {
  const engine = new CompletionEngine({ providers: [stubModel("ok;")], context: [new BufferContext()] });
  const provider = createInlineCompletionProvider(engine, { sleep: async () => {} });

  const result = await provider.provideInlineCompletionItems(
    fakeDocument("const x = "), { line: 0, character: 10 }, {}, fakeToken()
  );

  expect(result.items).toEqual([{ insertText: "ok;" }]);
});

test("returns no items when cancelled during the debounce wait", async () => {
  const engine = new CompletionEngine({ providers: [stubModel("ok;")], context: [new BufferContext()] });
  const token = fakeToken();
  const provider = createInlineCompletionProvider(engine, {
    sleep: async () => { token.cancel(); },
  });

  const result = await provider.provideInlineCompletionItems(
    fakeDocument("const x = "), { line: 0, character: 10 }, {}, token
  );

  expect(result.items).toEqual([]);
});

test("returns no items when the engine has nothing to offer", async () => {
  const engine = new CompletionEngine({ providers: [stubModel(null)], context: [new BufferContext()] });
  const provider = createInlineCompletionProvider(engine, { sleep: async () => {} });

  const result = await provider.provideInlineCompletionItems(
    fakeDocument("const x = "), { line: 0, character: 10 }, {}, fakeToken()
  );

  expect(result.items).toEqual([]);
});
