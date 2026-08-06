import { extname } from "node:path";

export interface LspServerConfig { command: string; args: string[]; languageIds: string[] }

export const DEFAULT_LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server", args: ["--stdio"],
    languageIds: ["typescript", "typescriptreact", "javascript", "javascriptreact"],
  },
  python: {
    command: "pyright-langserver", args: ["--stdio"],
    languageIds: ["python"],
  },
};

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescriptreact", js: "javascript", jsx: "javascriptreact", py: "python",
};

export function languageForPath(path: string): string | undefined {
  return EXT_LANGUAGE[extname(path).slice(1)];
}
