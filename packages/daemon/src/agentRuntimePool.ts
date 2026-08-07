import type { AgentRuntime } from "@zero/core";

/** Session-scoped AgentRuntime cache. Memoizes the *construction Promise*,
 * not just the resolved value: the cache check and the cache write must be
 * synchronous with respect to each other (no `await` between them) so two
 * concurrent callers for a session with no cached runtime yet converge on
 * the same in-flight construction instead of racing to each build - and
 * orphan - a separate AgentRuntime instance for the same session. */
export function createRuntimePool(
  build: (sessionId: string) => Promise<AgentRuntime>,
): (sessionId: string) => Promise<AgentRuntime> {
  const cache = new Map<string, Promise<AgentRuntime>>();
  return function runtimeFor(sessionId: string): Promise<AgentRuntime> {
    let rtPromise = cache.get(sessionId);
    if (rtPromise) return rtPromise;
    rtPromise = build(sessionId);
    cache.set(sessionId, rtPromise);
    return rtPromise;
  };
}
