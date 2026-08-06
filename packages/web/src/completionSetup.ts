import { CompletionEngine, CompletionScheduler, BufferContext, LspContext, GraphContext,
  ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
import type { EditorView } from "@codemirror/view";
import type { RpcClient } from "@zero/protocol";
import { setSuggestion } from "./ghostText";

export function createCompletion(client: RpcClient, getView: () => EditorView | undefined, path: () => string) {
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  const buffers = new BufferContext();
  const engine = new CompletionEngine({
    providers: [
      new ChromeNanoProvider(nanoApi),
      new OpenAICompatProvider({
        baseUrl: localStorage.getItem("zero.ollamaUrl") ?? "http://127.0.0.1:11434/v1",
        model: localStorage.getItem("zero.ollamaModel") ?? "qwen2.5-coder:1.5b",
      }),
    ],
    context: [buffers, new LspContext(client), new GraphContext(client)],
  });

  let latest = { prefix: "", suffix: "" };
  const scheduler = new CompletionScheduler(async (signal) => {
    const text = await engine.complete({ path: path(), ...latest }, signal);
    const view = getView();
    if (text && !signal.aborted && view) view.dispatch({ effects: setSuggestion.of(text) });
  });

  return {
    engine, buffers,
    request(s: { prefix: string; suffix: string }) { latest = s; scheduler.trigger(); },
  };
}
