import type { CompletionEngine } from "@zero/core";
import type { StatusBarItem } from "./plugins/registries";
import { StatusPill } from "../StatusPill";
import { PluginSlot } from "./plugins/PluginSlot";
import { Logomark } from "./theme/Logomark";

/** Compact token count for the status bar pill (6853 -> "6K", 262144 ->
 * "262K", 1_200_000 -> "1.2M") - the exact comma-formatted count stays
 * available via the pill's `title` tooltip. Truncates rather than rounds so
 * a count doesn't visually cross a full unit it hasn't actually reached
 * (e.g. 999,900 reads as "999K", not "1M"). */
export function formatCompactTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${Math.floor(n / 1_000)}K`;
  return `${Math.floor(n / 100_000) / 10}M`;
}

export type GraphStatus = {
  ready: boolean;
  indexing: boolean;
  lastError?: string;
  nodeCount?: number;
} | null;

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
  /** Chat context-window token usage from `chat/status`, polled by Workbench
   * for the active chat session. Null/absent fields mean no turn has run yet
   * for that session (or no session is active). */
  tokenStatus?: { usedTokens: number | null; contextWindowTokens: number | null } | null;
  /** Status bar items contributed by daemon plugins with a `ui` contribution
   * (e.g. the git plugin). Rendered after the built-in items. */
  statusBarItems?: StatusBarItem[];
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
        {props.tokenStatus?.usedTokens != null && props.tokenStatus.contextWindowTokens != null && (
          <span title={`${props.tokenStatus.usedTokens.toLocaleString()} / ${props.tokenStatus.contextWindowTokens.toLocaleString()} tokens`}>
            {formatCompactTokens(props.tokenStatus.usedTokens)} / {formatCompactTokens(props.tokenStatus.contextWindowTokens)} tokens
          </span>
        )}
        {props.statusBarItems?.map((item) => (
          <PluginSlot key={item.id} mount={item.mount} />
        ))}
        <StatusPill engine={props.engine} />
        <span style={{ opacity: 0.6, fontSize: 12 }} title="Zero version">v{__ZERO_VERSION__}</span>
        <button onClick={props.onToggleTheme} style={{ background: "transparent", border: "1px solid var(--zero-border)", color: "inherit", borderRadius: 4, fontSize: 13, padding: "2px 8px", cursor: "pointer" }}>
          {props.theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </div>
  );
}
