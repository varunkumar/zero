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
 * strips `:` so Windows drive letters don't produce an invalid path.
 *
 * Accepted collision risk: separators collapse to `-`, so distinct paths
 * like `/a/b` and `/a-b` both sanitize to `-a-b` and would share a session
 * directory. This mirrors the same tradeoff in the design spec ("same
 * convention... requiring no new collision handling") - not a bug to fix. */
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
