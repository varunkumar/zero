import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempZeroHome } from "../testSupport/zeroHome";
import { createCliContext } from "./runtimeFactory";

useTempZeroHome();

function fakeOllama(models: string[]): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: [] }), { headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

test("createCliContext uses an installed Ollama model instead of a hardcoded qwen default", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-cli-ctx-"));
  const ctx = await createCliContext(root, { fetchImpl: fakeOllama(["llama3.2:latest"]) });
  expect(ctx.activeModel).toBe("llama3.2:latest");
  expect(ctx.providers).toHaveLength(1);
  expect(ctx.providers[0]!.id).toBe("openai:llama3.2:latest");
});

test("createCliContext --model override wins when that model is installed", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-cli-ctx-"));
  const ctx = await createCliContext(root, {
    model: "mistral:latest",
    fetchImpl: fakeOllama(["llama3.2:latest", "mistral:latest"]),
  });
  expect(ctx.activeModel).toBe("mistral:latest");
  expect(ctx.providers[0]!.id).toBe("openai:mistral:latest");
});

test("createCliContext with no Ollama models yields no provider rather than a 404 default", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-cli-ctx-"));
  const ctx = await createCliContext(root, { fetchImpl: fakeOllama([]) });
  expect(ctx.activeModel).toBeNull();
  expect(ctx.providers).toEqual([]);
});

test("setModel rebuilds providers and persists the choice", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-cli-ctx-"));
  const ctx = await createCliContext(root, {
    fetchImpl: fakeOllama(["llama3.2:latest", "mistral:latest"]),
  });
  await ctx.setModel("mistral:latest");
  expect(ctx.activeModel).toBe("mistral:latest");
  expect(ctx.providers[0]!.id).toBe("openai:mistral:latest");
});
