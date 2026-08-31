import { CompletionEngine, CompletionScheduler, BufferContext, LspContext, GraphContext,
  ChromeNanoProvider, OpenAICompatProvider, DEFAULT_OLLAMA_BASE_URL, type NanoApi } from "@zero/core";
import type { EditorView } from "@codemirror/view";
import type { RpcClient } from "@zero/protocol";
import { setSuggestion } from "./ghostText";

export function buildCompletionStack(_client: RpcClient, opts?: { lite?: boolean }) {
  if (opts?.lite) return { providers: ["chrome-nano"], context: ["buffer"] };
  return { providers: ["chrome-nano", "openai-compat"], context: ["buffer", "lsp", "graph"] };
}

export function createCompletion(client: RpcClient, getView: () => EditorView | undefined, path: () => string, opts?: { lite?: boolean; model?: string; baseUrl?: string }) {
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  const buffers = new BufferContext();

  const lite = opts?.lite === true;
  const model = opts?.model ?? (typeof localStorage !== "undefined"
    ? (localStorage.getItem("zero.ollamaModel") ?? localStorage.getItem("zero.ollamaChatModel"))
    : null);
  const baseUrl = opts?.baseUrl
    ?? (typeof localStorage !== "undefined" ? localStorage.getItem("zero.ollamaUrl") : null)
    ?? DEFAULT_OLLAMA_BASE_URL;
  const providers = lite
    ? [new ChromeNanoProvider(nanoApi)]
    : [
        new ChromeNanoProvider(nanoApi),
        ...(model ? [new OpenAICompatProvider({ baseUrl, model })] : []),
      ];
  const context = lite
    ? [buffers]
    : [buffers, new LspContext(client), new GraphContext(client)];

  const engine = new CompletionEngine({
    providers,
    context,
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
