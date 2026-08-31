import type { ChatCapableProvider } from "./chatTypes";

export class ProviderGateway {
  constructor(private providers: ChatCapableProvider[]) {}

  /** Swap the provider list (e.g. after the user picks a different Ollama model). */
  replace(providers: ChatCapableProvider[]): void {
    this.providers = providers;
  }

  async pick(): Promise<ChatCapableProvider | null> {
    const available: ChatCapableProvider[] = [];
    for (const p of this.providers) {
      if (await p.available().catch(() => false)) available.push(p);
    }
    return available.find((p) => p.supportsTools()) ?? available[0] ?? null;
  }
}
