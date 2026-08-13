import { expect, test } from "bun:test";
import { buildCompletionStack } from "./completionSetup";

const fakeClient = { request: async () => ({}) } as never;

test("daemon stack includes Ollama, LSP, and graph", () => {
  const s = buildCompletionStack(fakeClient, { lite: false });
  expect(s.providers).toEqual(["chrome-nano", "openai-compat"]);
  expect(s.context).toEqual(["buffer", "lsp", "graph"]);
});

test("lite stack is Nano and buffer only", () => {
  const s = buildCompletionStack(fakeClient, { lite: true });
  expect(s.providers).toEqual(["chrome-nano"]);
  expect(s.context).toEqual(["buffer"]);
});
