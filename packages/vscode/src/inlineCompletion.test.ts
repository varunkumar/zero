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

test("discards the result and aborts the signal when cancelled during engine.complete()", async () => {
  let capturedSignal: AbortSignal | undefined;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const model: ModelProvider = {
    id: "stub",
    available: async () => true,
    capabilities: (): ModelCapabilities => ({ id: "stub", contextWindowTokens: 1000, supportsFim: false }),
    async *complete(_prompt, signal) {
      capturedSignal = signal;
      started();
      await gate;
      yield "ok;";
    },
  };

  const engine = new CompletionEngine({ providers: [model], context: [new BufferContext()] });
  const token = fakeToken();
  const provider = createInlineCompletionProvider(engine, { sleep: async () => {} });

  const resultPromise = provider.provideInlineCompletionItems(
    fakeDocument("const x = "), { line: 0, character: 10 }, {}, token
  );

  await startedPromise;
  token.cancel();
  release();

  const result = await resultPromise;

  expect(result.items).toEqual([]);
  expect(capturedSignal?.aborted).toBe(true);
});
