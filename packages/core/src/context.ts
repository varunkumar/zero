import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";

export async function gatherContext(
  providers: ContextProvider[], req: CompletionRequest, budgetMs: number,
): Promise<ContextChunk[]> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), budgetMs));
  const results = await Promise.all(providers.map((p) =>
    Promise.race([p.gather(req).catch(() => null), timeout])));
  return results.flatMap((r) => r ?? []);
}
