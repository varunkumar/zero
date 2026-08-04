export interface ModelCapabilities {
  id: string;
  contextWindowTokens: number;
  supportsFim: boolean;
}

export interface CompletionRequest {
  path: string;
  prefix: string;
  suffix: string;
  language?: string;
}

export interface ModelProvider {
  id: string;
  available(): Promise<boolean>;
  capabilities(): ModelCapabilities;
  complete(prompt: string, signal: AbortSignal): AsyncIterable<string>;
}

export interface ContextChunk {
  source: string;
  text: string;
  score: number;
  tokenCost: number;
}

export interface ContextProvider {
  name: string;
  gather(req: CompletionRequest): Promise<ContextChunk[]>;
}
