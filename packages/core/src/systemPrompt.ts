import type { ToolProvider } from "./chatTypes";

export interface WorkspaceInfo { activeFile?: string }

const BASE_LAYER = `You are Zero, an offline coding assistant embedded in the user's editor.
Answer concisely and precisely. When you need information about the user's
codebase, use the available tools instead of guessing. Only claim a file's
contents or a symbol's definition after reading it via a tool. Prefer plain
prose; use code blocks only for actual code or file contents.`;

export function buildSystemPrompt(opts: { tools: ToolProvider[]; workspace: WorkspaceInfo }): string {
  const toolLines = opts.tools.length
    ? opts.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")
    : "(no tools available)";
  const workspaceLines = opts.workspace.activeFile ? `Active file: ${opts.workspace.activeFile}` : "";

  return [BASE_LAYER, "Available tools:", toolLines, workspaceLines].filter(Boolean).join("\n\n");
}
