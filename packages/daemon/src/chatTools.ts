import type { ToolProvider } from "@zero/core";
import type { Workspace } from "./workspace";
import type { LspService } from "./lsp/service";
import type { execCommand as execCommandFn } from "./execCommand";
import type { GitCheckpoint } from "./gitCheckpoint";
import { diffPreview } from "./diffPreview";

export interface ChatToolsDeps {
  sessionId: string;
  ws: Pick<Workspace, "read" | "write" | "tree" | "search">;
  lsp: Pick<LspService, "hover" | "definition">;
  graphQuery: (p: { q: string; mode?: "neighbors" | "symbol" | "path"; budgetTokens?: number }) => unknown;
  execCommand: typeof execCommandFn;
  checkpoint: Pick<GitCheckpoint, "checkpoint">;
}

function tool(opts: {
  name: string; description: string; schema: object; needsApproval?: boolean;
  preview?: (args: never) => Promise<string>; execute: (args: never) => Promise<string>;
}): ToolProvider {
  return {
    name: opts.name, description: opts.description, schema: opts.schema, needsApproval: opts.needsApproval,
    preview: opts.preview as ((args: unknown) => Promise<string>) | undefined,
    execute: opts.execute as (args: unknown) => Promise<string>,
  };
}

async function readOrEmpty(ws: ChatToolsDeps["ws"], path: string): Promise<string> {
  try { return await ws.read(path); } catch { return ""; }
}

export function createChatTools(deps: ChatToolsDeps): ToolProvider[] {
  const { sessionId, ws, lsp, graphQuery, execCommand, checkpoint } = deps;

  return [
    tool({
      name: "fs_read", description: "Read a file's contents by workspace-relative path.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args: { path: string }) => ws.read(args.path),
    }),
    tool({
      name: "fs_tree", description: "List all files and directories in the workspace.",
      schema: { type: "object", properties: {} },
      execute: async () => JSON.stringify(await ws.tree()),
    }),
    tool({
      name: "fs_search", description: "Search file contents for a literal query string.",
      schema: { type: "object", properties: { query: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
      execute: async (args: { query: string; caseSensitive?: boolean }) => JSON.stringify(await ws.search(args.query, args.caseSensitive)),
    }),
    tool({
      name: "graph_query", description: "Query the codebase knowledge graph for symbols, neighbors, or paths.",
      schema: { type: "object", properties: { q: { type: "string" }, mode: { type: "string", enum: ["neighbors", "symbol", "path"] } }, required: ["q"] },
      execute: async (args: { q: string; mode?: "neighbors" | "symbol" | "path" }) => (graphQuery(args) as { text: string }).text,
    }),
    tool({
      name: "lsp_hover", description: "Get type/hover information at a file position (0-based line and character).",
      schema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      execute: async (args: { path: string; line: number; character: number }) =>
        (await lsp.hover(args.path, { line: args.line, character: args.character })) ?? "no hover info",
    }),
    tool({
      name: "lsp_definition", description: "Find the definition location(s) of the symbol at a file position (0-based line and character).",
      schema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" }, character: { type: "number" } }, required: ["path", "line", "character"] },
      execute: async (args: { path: string; line: number; character: number }) =>
        JSON.stringify(await lsp.definition(args.path, { line: args.line, character: args.character })),
    }),

    tool({
      name: "fs_write", description: "Create or overwrite a file with the given content. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      needsApproval: true,
      preview: async (args: { path: string; content: string }) => diffPreview(await readOrEmpty(ws, args.path), args.content),
      execute: async (args: { path: string; content: string }) => {
        await ws.write(args.path, args.content);
        await checkpoint.checkpoint(sessionId, `agent: fs_write ${args.path}`);
        return `wrote ${args.path}`;
      },
    }),
    tool({
      name: "fs_edit", description: "Replace an exact, unique occurrence of oldText with newText in a file. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
      needsApproval: true,
      preview: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await readOrEmpty(ws, args.path);
        const count = content.split(args.oldText).length - 1;
        if (count !== 1) return `error: oldText matches ${count} locations in ${args.path}; must be unique`;
        return diffPreview(content, content.replace(args.oldText, args.newText));
      },
      execute: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await ws.read(args.path);
        const count = content.split(args.oldText).length - 1;
        if (count === 0) throw new Error(`oldText not found in ${args.path}`);
        if (count > 1) throw new Error(`oldText matches ${count} locations in ${args.path}; must be unique`);
        await ws.write(args.path, content.replace(args.oldText, args.newText));
        await checkpoint.checkpoint(sessionId, `agent: fs_edit ${args.path}`);
        return `edited ${args.path}`;
      },
    }),
    tool({
      name: "run_command", description: "Run a shell command in the workspace and return its combined output. Requires approval.",
      schema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] },
      needsApproval: true,
      preview: async (args: { command: string }) => args.command,
      execute: async (args: { command: string; cwd?: string }) => {
        const { exitCode, output } = await execCommand(args.command, args.cwd ?? ".");
        const summary = `exit ${exitCode}\n${output}`;
        // Reuse fs write's checkpoint precondition (diffPreview on the workspace
        // root is not applicable to a command; checkpoint() itself no-ops if
        // `git add -A` finds nothing changed, so it's safe to call unconditionally.
        await checkpoint.checkpoint(sessionId, `agent: run_command ${args.command}`);
        return summary;
      },
    }),
  ];
}
