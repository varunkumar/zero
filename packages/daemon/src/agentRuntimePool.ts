import type { AgentRuntime } from "@zero/core";

export interface AgentRuntimePool {
  (sessionId: string): Promise<AgentRuntime>;
  /** True if a runtime for this session is already cached (constructed or
   * under construction). Lets callers (e.g. chat/status) check without
   * triggering a build. */
  has(sessionId: string): boolean;
  /** Remove a session's cached runtime (and in-flight construction promise,
   * if any) from the pool. Call this when a session is deleted so the pool
   * doesn't retain providers/tools for it forever. */
  evict(sessionId: string): void;
  /** Drop every cached runtime. Call this when the active model changes so
   * the next chat/turn rebuilds providers against the new name. */
  evictAll(): void;
}

/** Session-scoped AgentRuntime cache. Memoizes the *construction Promise*,
 * not just the resolved value: the cache check and the cache write must be
 * synchronous with respect to each other (no `await` between them) so two
 * concurrent callers for a session with no cached runtime yet converge on
 * the same in-flight construction instead of racing to each build - and
 * orphan - a separate AgentRuntime instance for the same session. */
export function createRuntimePool(
  build: (sessionId: string) => Promise<AgentRuntime>,
): AgentRuntimePool {
  const cache = new Map<string, Promise<AgentRuntime>>();
  const runtimeFor = function runtimeFor(sessionId: string): Promise<AgentRuntime> {
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
  } as AgentRuntimePool;
  runtimeFor.has = (sessionId: string) => cache.has(sessionId);
  runtimeFor.evict = (sessionId: string) => { cache.delete(sessionId); };
  runtimeFor.evictAll = () => { cache.clear(); };
  return runtimeFor;
}
