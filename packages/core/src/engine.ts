import type { CompletionRequest, ContextProvider, ModelProvider } from "./types";
import { gatherContext } from "./context";
import { buildFimPrompt } from "./prompt";

export interface EngineStatus { activeModel: string | null; reason: string | null }

export class CompletionEngine {
  #providers: ModelProvider[];
  #context: ContextProvider[];
  #budgetMs: number;
  #status: EngineStatus = { activeModel: null, reason: null };
  #listeners = new Set<(s: EngineStatus) => void>();
  #availCache = new Map<string, { ok: boolean; at: number }>();

  constructor(opts: { providers: ModelProvider[]; context: ContextProvider[]; contextBudgetMs?: number }) {
    this.#providers = opts.providers;
    this.#context = opts.context;
    this.#budgetMs = opts.contextBudgetMs ?? 50;
  }

  status() { return this.#status; }
  onStatusChange(fn: (s: EngineStatus) => void) { this.#listeners.add(fn); }
  #setStatus(s: EngineStatus) {
    this.#status = s;
    for (const fn of this.#listeners) fn(s);
  }

  async #pick(): Promise<ModelProvider | null> {
    for (const p of this.#providers) {
      const cached = this.#availCache.get(p.id);
      let ok: boolean;
      if (cached && Date.now() - cached.at < 30_000) {
        ok = cached.ok;
      } else {
        ok = await p.available().catch(() => false);
        this.#availCache.set(p.id, { ok, at: Date.now() });
      }
      if (ok) return p;
    }
    return null;
  }

  async complete(req: CompletionRequest, signal: AbortSignal): Promise<string | null> {
    const provider = await this.#pick();
    if (!provider) { this.#setStatus({ activeModel: null, reason: "no model available" }); return null; }
    this.#setStatus({ activeModel: provider.id, reason: null });
    if (signal.aborted) return null;
    const chunks = await gatherContext(this.#context, req, this.#budgetMs);
    const prompt = buildFimPrompt(req, chunks, provider.capabilities());
    let out = "";
    try {
      for await (const piece of provider.complete(prompt, signal)) {
        if (signal.aborted) return null;
        out += piece;
      }
    } catch { return null; }
    return signal.aborted ? null : out || null;
  }
}
