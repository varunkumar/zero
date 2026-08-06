import { expect, test } from "bun:test";
import { buildSystemPrompt } from "./systemPrompt";
import type { ToolProvider } from "./chatTypes";

function tool(name: string, description: string): ToolProvider {
  return { name, description, schema: {}, execute: async () => "" };
}

test("lists each tool's name and description", () => {
  const prompt = buildSystemPrompt({
    tools: [tool("fs_read", "Read a file by path."), tool("graph_query", "Query the codebase graph.")],
    workspace: {},
  });
  expect(prompt).toContain("fs_read: Read a file by path.");
  expect(prompt).toContain("graph_query: Query the codebase graph.");
});

test("says so explicitly when there are no tools", () => {
  const prompt = buildSystemPrompt({ tools: [], workspace: {} });
  expect(prompt).toContain("no tools available");
});

test("includes the active file when present, omits it when absent", () => {
  const withFile = buildSystemPrompt({ tools: [], workspace: { activeFile: "src/app.ts" } });
  expect(withFile).toContain("Active file: src/app.ts");

  const withoutFile = buildSystemPrompt({ tools: [], workspace: {} });
  expect(withoutFile).not.toContain("Active file:");
});
