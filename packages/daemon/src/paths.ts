import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.zero` by default; overridable via ZERO_HOME so tests never touch a
 * real home directory. Read fresh on every call (not memoized) so tests can
 * change the env var between cases. */
export function zeroHome(): string {
  return process.env.ZERO_HOME ?? join(homedir(), ".zero");
}

/** Turns an absolute workspace path into a flat, filesystem-safe directory
 * name, the same convention Claude Code itself uses for its own
 * per-project directories (e.g. `/Users/x/proj` -> `-Users-x-proj`). Also
 * strips `:` so Windows drive letters don't produce an invalid path. */
export function sanitizeWorkspacePath(root: string): string {
  const collapsed = root.replace(/[\\/:]+/g, "-").replace(/^-+/, "");
  return `-${collapsed}`;
}

export function sessionsDir(workspaceRoot: string): string {
  return join(zeroHome(), "sessions", sanitizeWorkspacePath(workspaceRoot));
}

export function settingsPath(): string {
  return join(zeroHome(), "settings.json");
}
