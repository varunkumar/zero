import { expect, test } from "bun:test";
import { listCompatModels, listRunningOllamaModels, resolveCompatModel } from "./compatModels";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("listCompatModels reads ids from an OpenAI-compat /models payload", async () => {
  const fetchImpl = async (input: string) => {
    expect(String(input)).toBe("http://127.0.0.1:11434/v1/models");
    return jsonResponse({ data: [{ id: "llama3.2:latest" }, { id: "qwen2.5-coder:7b" }] });
  };
  expect(await listCompatModels("http://127.0.0.1:11434/v1", fetchImpl)).toEqual([
    "llama3.2:latest",
    "qwen2.5-coder:7b",
  ]);
});

test("listCompatModels also accepts Ollama /api/tags-shaped payloads (name field)", async () => {
  const fetchImpl = async () => jsonResponse({ models: [{ name: "mistral:latest" }] });
  expect(await listCompatModels("http://x/v1", fetchImpl)).toEqual(["mistral:latest"]);
});

test("listCompatModels returns [] when the endpoint is down", async () => {
  const fetchImpl = async () => { throw new Error("refused"); };
  expect(await listCompatModels("http://x/v1", fetchImpl)).toEqual([]);
});

test("listRunningOllamaModels hits the native /api/ps URL derived from a /v1 base", async () => {
  const fetchImpl = async (input: string) => {
    expect(String(input)).toBe("http://127.0.0.1:11434/api/ps");
    return jsonResponse({ models: [{ name: "llama3.2:latest" }] });
  };
  expect(await listRunningOllamaModels("http://127.0.0.1:11434/v1", fetchImpl)).toEqual(["llama3.2:latest"]);
});

test("listRunningOllamaModels returns [] on a non-Ollama OpenAI-compat host", async () => {
  const fetchImpl = async () => new Response("nope", { status: 404 });
  expect(await listRunningOllamaModels("http://example/v1", fetchImpl)).toEqual([]);
});

test("resolveCompatModel keeps a preferred model that is still installed", () => {
  expect(resolveCompatModel({
    preferred: "qwen2.5-coder:7b",
    available: ["llama3.2:latest", "qwen2.5-coder:7b"],
  })).toBe("qwen2.5-coder:7b");
});

test("resolveCompatModel does not keep a preferred model that was uninstalled (the 404 case)", () => {
  expect(resolveCompatModel({
    preferred: "qwen2.5-coder:7b",
    available: ["llama3.2:latest"],
  })).toBe("llama3.2:latest");
});

test("resolveCompatModel prefers a currently loaded Ollama model when the saved one is gone", () => {
  expect(resolveCompatModel({
    preferred: "qwen2.5-coder:7b",
    available: ["mistral:latest", "llama3.2:latest"],
    running: ["llama3.2:latest"],
  })).toBe("llama3.2:latest");
});

test("resolveCompatModel with no preference uses the running model, else the first installed", () => {
  expect(resolveCompatModel({
    available: ["mistral:latest", "llama3.2:latest"],
    running: ["llama3.2:latest"],
  })).toBe("llama3.2:latest");
  expect(resolveCompatModel({
    available: ["mistral:latest", "llama3.2:latest"],
  })).toBe("mistral:latest");
});

test("resolveCompatModel returns undefined when nothing is installed, rather than inventing a name", () => {
  expect(resolveCompatModel({ preferred: "qwen2.5-coder:7b", available: [] })).toBeUndefined();
  expect(resolveCompatModel({ available: [] })).toBeUndefined();
});

test("resolveCompatModel matches a preferred name to a :latest tag", () => {
  expect(resolveCompatModel({
    preferred: "llama3.2",
    available: ["llama3.2:latest"],
  })).toBe("llama3.2:latest");
});
