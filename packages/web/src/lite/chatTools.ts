import { diffPreview, type ToolProvider } from "@zero/core";
import type { BrowserFSWorkspace } from "./browserFs";

export type LiteChatToolsFs = Pick<BrowserFSWorkspace, "read" | "write" | "tree" | "search">;

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

async function readOrEmpty(fs: LiteChatToolsFs, path: string): Promise<string> {
  try {
    return await fs.read(path);
  } catch {
    return "";
  }
}

/** Same tool names, schemas, and approval semantics as the daemon's
 * `createChatTools` (`packages/daemon/src/chatTools.ts`), bound to the
 * in-browser `BrowserFSWorkspace` instead of the daemon's `Workspace`.
 * Deliberately excludes `run_command` (no process execution in the browser)
 * and the git-checkpoint side effect (no git in Lite mode). */
export function createLiteChatTools(fs: LiteChatToolsFs): ToolProvider[] {
  return [
    tool({
      name: "fs_read", description: "Read a file's contents by workspace-relative path.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async (args: { path: string }) => fs.read(args.path),
    }),
    tool({
      name: "fs_tree", description: "List all files and directories in the workspace.",
      schema: { type: "object", properties: {} },
      execute: async () => JSON.stringify(await fs.tree()),
    }),
    tool({
      name: "fs_search", description: "Search file contents for a literal query string.",
      schema: { type: "object", properties: { query: { type: "string" }, caseSensitive: { type: "boolean" } }, required: ["query"] },
      execute: async (args: { query: string; caseSensitive?: boolean }) => JSON.stringify(await fs.search(args.query, args.caseSensitive)),
    }),
    tool({
      name: "fs_write", description: "Create or overwrite a file with the given content. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      needsApproval: true,
      preview: async (args: { path: string; content: string }) => diffPreview(await readOrEmpty(fs, args.path), args.content),
      execute: async (args: { path: string; content: string }) => {
        await fs.write(args.path, args.content);
        return `wrote ${args.path}`;
      },
    }),
    tool({
      name: "fs_edit", description: "Replace an exact, unique occurrence of oldText with newText in a file. Requires approval.",
      schema: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] },
      needsApproval: true,
      preview: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await readOrEmpty(fs, args.path);
        const count = content.split(args.oldText).length - 1;
        if (count === 0) throw new Error(`oldText not found in ${args.path}`);
        if (count > 1) throw new Error(`oldText matches ${count} locations in ${args.path}; must be unique`);
        return diffPreview(content, content.replace(args.oldText, args.newText));
      },
      execute: async (args: { path: string; oldText: string; newText: string }) => {
        const content = await fs.read(args.path);
        const count = content.split(args.oldText).length - 1;
        if (count === 0) throw new Error(`oldText not found in ${args.path}`);
        if (count > 1) throw new Error(`oldText matches ${count} locations in ${args.path}; must be unique`);
        await fs.write(args.path, content.replace(args.oldText, args.newText));
        return `edited ${args.path}`;
      },
    }),
  ];
}
