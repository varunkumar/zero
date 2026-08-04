import type { CompletionRequest, ContextChunk, ContextProvider } from "./types";

export async function gatherContext(
  providers: ContextProvider[], req: CompletionRequest, budgetMs: number,
  now: () => number = Date.now,
): Promise<ContextChunk[]> {
  // `now` establishes the deadline for callers/tests that want to reason
  // about elapsed time against an injectable clock. The race itself still
  // relies on setTimeout (a real timer, not a polled clock), so `deadline`
  // isn't consulted again below — it exists to make `now` load-bearing.
  const deadline = now() + budgetMs;
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, deadline - now())));
  const results = await Promise.all(providers.map((p) =>
    Promise.race([p.gather(req).catch(() => null), timeout])));
  return results.flatMap((r) => r ?? []);
}
