import type { ToolProvider } from "@zero/core";
import type { RpcClient } from "@zero/protocol";

function tool(name: string, description: string, schema: object, execute: (args: never) => Promise<string>): ToolProvider {
  return { name, description, schema, execute: execute as (args: unknown) => Promise<string> };
}

export function createChatTools(client: RpcClient): ToolProvider[] {
  return [
    tool(
      "fs_read", "Read a file's contents by workspace-relative path.",
      { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async (args: { path: string }) => (await client.request<{ content: string }>("fs/read", { path: args.path })).content,
    ),
    tool(
      "fs_tree", "List all files and directories in the workspace.",
      { type: "object", properties: {} },
      async () => JSON.stringify((await client.request<{ entries: { path: string; kind: string }[] }>("fs/tree")).entries),
    ),
    tool(
      "fs_search", "Search file contents for a literal query string.",
      { type: "object", properties: { query: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
      async (args: { query: string; caseSensitive?: boolean }) => JSON.stringify(await client.request("fs/search", args)),
    ),
    tool(
      "graph_query", "Query the codebase knowledge graph for symbols, neighbors, or paths.",
      { type: "object", properties: { q: { type: "string" }, mode: { type: "string", enum: ["neighbors", "symbol", "path"] } }, required: ["q"] },
      async (args: { q: string; mode?: "neighbors" | "symbol" | "path" }) =>
        (await client.request<{ text: string }>("graph/query", args)).text,
    ),
    tool(
      "lsp_hover", "Get type/hover information at a file position (0-based line and character).",
      { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      async (args: { path: string; line: number; character: number }) =>
        (await client.request<{ contents: string | null }>("lsp/hover", { path: args.path, position: { line: args.line, character: args.character } })).contents
          ?? "no hover info",
    ),
    tool(
      "lsp_definition", "Find the definition location(s) of the symbol at a file position (0-based line and character).",
      { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      async (args: { path: string; line: number; character: number }) =>
        JSON.stringify(await client.request("lsp/definition", { path: args.path, position: { line: args.line, character: args.character } })),
    ),
  ];
}
