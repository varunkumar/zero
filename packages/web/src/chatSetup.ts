import { AgentRuntime, ChromeNanoProvider, OpenAICompatProvider, type NanoApi } from "@zero/core";
import type { RpcClient } from "@zero/protocol";
import { createChatTools } from "./chatTools";

export function createChat(client: RpcClient, activeFile: () => string | undefined): AgentRuntime {
  const nanoApi = (globalThis as { LanguageModel?: NanoApi }).LanguageModel;
  return new AgentRuntime({
    providers: [
      new ChromeNanoProvider(nanoApi),
      new OpenAICompatProvider({
        baseUrl: localStorage.getItem("zero.ollamaUrl") ?? "http://127.0.0.1:11434/v1",
        model: localStorage.getItem("zero.ollamaChatModel") ?? "qwen2.5-coder:7b",
      }),
    ],
    tools: createChatTools(client),
    client: { request: (method, params) => client.request(method, params) },
    workspace: () => ({ activeFile: activeFile() }),
  });
}
