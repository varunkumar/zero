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
    // If construction fails, evict so the next call retries fresh instead
    // of re-awaiting the same permanently-rejected promise forever - a
    // transient failure (e.g. a bad settings read) shouldn't wall off chat
    // for the rest of the session's life. Guard with the identity check so
    // a later, successful promise that already replaced this one in the
    // cache isn't accidentally evicted. The rejection itself still
    // propagates normally to whichever caller(s) are awaiting rtPromise.
    rtPromise.catch(() => {
      if (cache.get(sessionId) === rtPromise) cache.delete(sessionId);
    });
    return rtPromise;
  };
}
