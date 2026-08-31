import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { useTempZeroHome } from "./testSupport/zeroHome";
import { loadOllamaCatalog, writeOllamaModel, OLLAMA_MODEL_KEY, OLLAMA_CHAT_MODEL_KEY } from "./ollamaConfig";

useTempZeroHome();

function fakeOllama(opts: { models: string[]; running?: string[] }): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/ps")) {
      return new Response(JSON.stringify({ models: (opts.running ?? []).map((name) => ({ name })) }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: opts.models.map((id) => ({ id })) }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

test("loadOllamaCatalog picks the first installed model when nothing is saved", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  const catalog = await loadOllamaCatalog(ws, fakeOllama({ models: ["llama3.2:latest", "mistral:latest"] }));
  expect(catalog.models).toEqual(["llama3.2:latest", "mistral:latest"]);
  expect(catalog.active).toBe("llama3.2:latest");
});

test("loadOllamaCatalog does not send a saved model that is no longer installed", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_MODEL_KEY, "qwen2.5-coder:7b");
  const catalog = await loadOllamaCatalog(ws, fakeOllama({
    models: ["llama3.2:latest"],
    running: ["llama3.2:latest"],
  }));
  expect(catalog.active).toBe("llama3.2:latest");
});

test("loadOllamaCatalog rewrites a stale saved model to the resolved active one", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_MODEL_KEY, "qwen2.5-coder:7b");
  await loadOllamaCatalog(ws, fakeOllama({
    models: ["qwen3.8:27b-mlx"],
    running: ["qwen3.8:27b-mlx"],
  }));
  expect(await ws.readSetting(OLLAMA_MODEL_KEY)).toBe("qwen3.8:27b-mlx");
});

test("loadOllamaCatalog copies the legacy chat-model key onto zero.ollamaModel", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_CHAT_MODEL_KEY, "mistral:latest");
  await loadOllamaCatalog(ws, fakeOllama({ models: ["mistral:latest", "llama3.2:latest"] }));
  expect(await ws.readSetting(OLLAMA_MODEL_KEY)).toBe("mistral:latest");
  expect(await ws.readSetting(OLLAMA_CHAT_MODEL_KEY)).toBe("mistral:latest");
});

test("loadOllamaCatalog persists an auto-picked model so later processes share it", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await loadOllamaCatalog(ws, fakeOllama({ models: ["qwen3.8:27b-mlx"] }));
  expect(await ws.readSetting(OLLAMA_MODEL_KEY)).toBe("qwen3.8:27b-mlx");
});

test("a --model override does not rewrite persisted settings", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_MODEL_KEY, "llama3.2:latest");
  await loadOllamaCatalog(
    ws,
    fakeOllama({ models: ["llama3.2:latest", "mistral:latest"] }),
    "mistral:latest",
  );
  expect(await ws.readSetting(OLLAMA_MODEL_KEY)).toBe("llama3.2:latest");
});

test("loadOllamaCatalog honors a still-installed saved model", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_MODEL_KEY, "mistral:latest");
  const catalog = await loadOllamaCatalog(ws, fakeOllama({ models: ["llama3.2:latest", "mistral:latest"] }));
  expect(catalog.active).toBe("mistral:latest");
});

test("loadOllamaCatalog falls back to the legacy chat-model setting key", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await ws.writeSetting(OLLAMA_CHAT_MODEL_KEY, "mistral:latest");
  const catalog = await loadOllamaCatalog(ws, fakeOllama({ models: ["mistral:latest"] }));
  expect(catalog.active).toBe("mistral:latest");
});

test("writeOllamaModel persists zero.ollamaModel", async () => {
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "zero-ollama-")));
  await writeOllamaModel(ws, "llama3.2:latest");
  expect(await ws.readSetting(OLLAMA_MODEL_KEY)).toBe("llama3.2:latest");
});
