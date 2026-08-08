import { randomBytes } from "node:crypto";
import type { ProviderGateway } from "@zero/core";
import { anthropicRequestToChat, chatDeltaToSseEvents, finalSseEvents, createSseState } from "@zero/core";

export interface ModelGatewayOpts { port?: number; apiKey?: string; gateway: ProviderGateway }

export function startModelGateway(opts: ModelGatewayOpts): { port: number; apiKey: string; stop(): void } {
  const apiKey = opts.apiKey ?? randomBytes(16).toString("hex");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/messages" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (req.headers.get("x-api-key") !== apiKey) {
        return new Response("unauthorized", { status: 401 });
      }

      const provider = await opts.gateway.pick();
      if (!provider) return new Response("no model available", { status: 503 });

      const body = await req.json();
      const { messages, tools } = anthropicRequestToChat(body);
      const state = createSseState(provider.id);
      const controller = new AbortController();
      req.signal.addEventListener("abort", () => controller.abort());

      const stream = new ReadableStream<Uint8Array>({
        async start(sc) {
          const encoder = new TextEncoder();
          let sawToolCalls = false;
          try {
            for await (const delta of provider.chat(messages, tools, controller.signal)) {
              if (delta.toolCalls?.length) sawToolCalls = true;
              for (const event of chatDeltaToSseEvents(delta, state)) sc.enqueue(encoder.encode(event));
            }
            for (const event of finalSseEvents(state, sawToolCalls ? "tool_use" : "end_turn")) sc.enqueue(encoder.encode(event));
          } catch (e) {
            sc.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: e instanceof Error ? e.message : String(e) })}\n\n`));
          } finally {
            sc.close();
          }
        },
      });

      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  return { port: server.port as number, apiKey, stop: () => server.stop() };
}
