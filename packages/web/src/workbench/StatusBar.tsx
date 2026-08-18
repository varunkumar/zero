import type { CompletionEngine } from "@zero/core";
import { StatusPill } from "../StatusPill";
import { Logomark } from "./theme/Logomark";

export type GraphStatus = {
  ready: boolean;
  indexing: boolean;
  lastError?: string;
  nodeCount?: number;
} | null;

/** Normalizes `git@github.com:x/y.git` / `https://github.com/x/y.git` remote
 * strings into an https browsable URL. */
function toHttpsUrl(remote: string): string {
  const sshMatch = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2]}`;
  return remote.replace(/\.git$/, "");
}

export function StatusBar(props: {
  engine: CompletionEngine;
  path: string | null;
  cursor: { line: number; column: number } | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Transient failure notice (save/open errors); the bar inherited this role
   * from the old top bar's `status` string. */
  message?: { text: string; tone: "error" | "info" } | null;
  lspStatus: { path: string; count: number; failed: boolean } | null;
  /** Graphify indexer status from `graph/status`, polled by Workbench. */
  graphStatus?: GraphStatus;
  /** Git branch/dirty/remote status from `git/status`, polled by Workbench.
   * Null when `root` isn't inside a git work tree. */
  gitStatus?: { branch: string; dirtyCount: number; remoteUrl: string | null } | null;
  /** Chat context-window token usage from `chat/status`, polled by Workbench
   * for the active chat session. Null/absent fields mean no turn has run yet
   * for that session (or no session is active). */
  tokenStatus?: { usedTokens: number | null; contextWindowTokens: number | null } | null;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 16px", fontSize: 14,
        flexShrink: 0,
        background: "var(--zero-statusbar-bg)", color: "var(--zero-statusbar-fg)",
        borderTop: "1px solid var(--zero-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Logomark theme={props.theme} size={22} />
        <span>{props.path ?? "no file open"}</span>
        {props.cursor && <span>Ln {props.cursor.line}, Col {props.cursor.column}</span>}
        {props.message && (
          <span
            role="status"
            style={{
              color: props.message.tone === "error" ? "var(--zero-error-fg, crimson)" : "inherit",
              maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {props.message.text}
          </span>
        )}
      </div>
      <div className="zero-statusbar-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {props.lspStatus && props.lspStatus.failed && (
          <span role="status" title={`Language server unavailable for ${props.lspStatus.path}`}
            style={{ color: "var(--zero-statusbar-fg)", opacity: 0.7 }}>
            LSP unavailable
          </span>
        )}
        {props.lspStatus && !props.lspStatus.failed && props.lspStatus.count > 0 && (
          <span role="status" title={`${props.lspStatus.count} problem(s) in ${props.lspStatus.path}`}
            style={{ color: "var(--zero-error-fg, crimson)" }}>
            {props.lspStatus.count} problem{props.lspStatus.count === 1 ? "" : "s"}
          </span>
        )}
        {props.graphStatus && (
          <span title={props.graphStatus.lastError ?? ""}>
            {props.graphStatus.indexing
              ? "Indexing…"
              : props.graphStatus.ready
                ? `Graph ${props.graphStatus.nodeCount ?? ""}`
                : "Graph off"}
          </span>
        )}
        {props.gitStatus && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>{props.gitStatus.branch}</span>
            {props.gitStatus.dirtyCount > 0 && (
              <span title={`${props.gitStatus.dirtyCount} uncommitted change(s)`}
                style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--zero-accent)" }} />
            )}
            {props.gitStatus.remoteUrl && (
              <a href={toHttpsUrl(props.gitStatus.remoteUrl)} target="_blank" rel="noreferrer"
                style={{ color: "inherit" }} title="Open repository on GitHub">GitHub</a>
            )}
          </span>
        )}
        {props.tokenStatus?.usedTokens != null && props.tokenStatus.contextWindowTokens != null && (
          <span title="Chat context window usage">
            {props.tokenStatus.usedTokens.toLocaleString()} / {props.tokenStatus.contextWindowTokens.toLocaleString()} tokens
          </span>
        )}
        <StatusPill engine={props.engine} />
        <span style={{ opacity: 0.6, fontSize: 12 }} title="Zero version">v{__ZERO_VERSION__}</span>
        <button onClick={props.onToggleTheme} style={{ background: "transparent", border: "1px solid var(--zero-border)", color: "inherit", borderRadius: 4, fontSize: 13, padding: "2px 8px", cursor: "pointer" }}>
          {props.theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </div>
  );
}
