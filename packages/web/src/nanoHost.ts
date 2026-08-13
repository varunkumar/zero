import { ChromeNanoProvider, probeNano, type NanoApi, type ChatMessage, type ChatToolSpec } from "@zero/core";

export interface VisibilityDoc {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", handler: () => void): void;
}

export interface NanoHostClient {
  request<R>(method: string, params?: unknown): Promise<R>;
  notify(method: string, params?: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

export interface NanoHostOpts {
  client: NanoHostClient;
  nanoApi: NanoApi | undefined;
  doc?: VisibilityDoc;
}

/** Registers this daemon-mode tab as the (foreground-only) Nano host for
 * the daemon's Claude Code bridge, and answers reverse `nano/chat` calls by
 * running ChromeNanoProvider locally. Never called in Lite mode - there is
 * no daemon to register with. */
export function setupNanoHost(opts: NanoHostOpts): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  const provider = new ChromeNanoProvider(opts.nanoApi);
  let registered = false;

  opts.client.onRequest("nano/chat", async (params) => {
    const { requestId, messages, tools } = params as { requestId: string; messages: ChatMessage[]; tools: ChatToolSpec[] };
    const controller = new AbortController();
    for await (const delta of provider.chat(messages, tools, controller.signal)) {
      opts.client.notify("nano/chatDelta", { requestId, delta });
    }
    return { done: true };
  });

  async function syncRegistration() {
    const ready = (await probeNano(opts.nanoApi)) === "ready";
    const visible = !doc || doc.visibilityState === "visible";
    if (ready && visible && !registered) {
      registered = true;
      await opts.client.request("nano/register").catch(() => { registered = false; });
    } else if ((!ready || !visible) && registered) {
      registered = false;
      await opts.client.request("nano/unregister").catch(() => {});
    }
  }

  doc?.addEventListener("visibilitychange", () => { void syncRegistration(); });
  void syncRegistration();
}
