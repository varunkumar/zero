import type { AgentRuntimeClient } from "@zero/core";
import type { ChatMessage } from "@zero/protocol";
import type { SessionStore } from "./sessions";

/** AgentRuntime's injected client interface, adapted directly onto
 * SessionStore in-process. Previously (M4) the browser's AgentRuntime used
 * this same interface to call "chat/get"/"chat/append" over a WebSocket
 * round-trip to itself; now that AgentRuntime runs inside the daemon there's
 * no socket to round-trip through, so this just calls the store. */
export function createAgentRuntimeClient(sessions: SessionStore): AgentRuntimeClient {
  return {
    async request<R>(method: string, params?: unknown): Promise<R> {
      if (method === "chat/get") {
        const { id } = params as { id: string };
        const s = await sessions.get(id);
        if (!s) throw new Error(`no such session: ${id}`);
        return { messages: s.messages } as unknown as R;
      }
      if (method === "chat/append") {
        const { id, messages } = params as { id: string; messages: ChatMessage[] };
        await sessions.append(id, messages);
        return {} as R;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}
