import { randomBytes } from "node:crypto";
import type { ProviderGateway } from "@zero/core";
import { anthropicRequestToChat, chatDeltaToSseEvents, finalSseEvents, createSseState } from "@zero/core";

export interface ModelGatewayOpts { port?: number; apiKey?: string; gateway: ProviderGateway }

// SSE streaming only; non-streaming `stream:false` requests are not yet supported.
export function startModelGateway(opts: ModelGatewayOpts): { port: number; apiKey: string; stop(): void } {
  const apiKey = opts.apiKey ?? randomBytes(16).toString("hex");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      // Deliberately unauthenticated (unlike /v1/messages): a loopback-bound
      // probe for local health checks and scripts, exposing only a provider
      // id string and an attach flag, never model input or output.
      if (url.pathname === "/health" && req.method === "GET") {
        const provider = await opts.gateway.pick();
        return Response.json({
          nanoHostConnected: provider?.id === "nano-bridge",
          provider: provider?.id ?? null,
          supportsTools: provider?.supportsTools() ?? false,
        });
      }
      if (url.pathname === "/v1/complete" && req.method === "POST") {
        if (req.headers.get("x-api-key") !== apiKey) {
          return new Response("unauthorized", { status: 401 });
        }
        const provider = await opts.gateway.pick();
        if (!provider) return new Response("no model available", { status: 503 });

        let prompt: unknown;
        try {
          ({ prompt } = await req.json());
        } catch (e) {
          return new Response(`invalid request body: ${e instanceof Error ? e.message : String(e)}`, { status: 400 });
        }
        if (typeof prompt !== "string") {
          return new Response("invalid request body: prompt must be a string", { status: 400 });
        }

        const controller = new AbortController();
        req.signal.addEventListener("abort", () => controller.abort());
        let text = "";
        try {
          const content =
            prompt +
            " Reply with only the code continuation, no explanation, no markdown code fences, no usage examples, and keep it under a few lines.";
          const messages = [{ role: "user" as const, content, createdAt: Date.now() }];
          for await (const delta of provider.chat(messages, [], controller.signal)) {
            if (delta.text) text += delta.text;
          }
        } catch (e) {
          return new Response(`completion failed: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
        }
        return Response.json({ text });
      }

      if (url.pathname !== "/v1/messages" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      if (req.headers.get("x-api-key") !== apiKey) {
        return new Response("unauthorized", { status: 401 });
      }

      const provider = await opts.gateway.pick();
      if (!provider) return new Response("no model available", { status: 503 });

      let messages, tools;
      try {
        const body = await req.json();
        ({ messages, tools } = anthropicRequestToChat(body));
      } catch (e) {
        return new Response(`invalid request body: ${e instanceof Error ? e.message : String(e)}`, { status: 400 });
      }
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
