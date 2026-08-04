import type { CompletionEngine } from "@zero/core";
import { StatusPill } from "../StatusPill";
import { Logomark } from "./theme/Logomark";

export function StatusBar(props: {
  engine: CompletionEngine;
  path: string | null;
  cursor: { line: number; column: number } | null;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "2px 8px", fontSize: 12,
        background: "var(--zero-statusbar-bg)", color: "var(--zero-statusbar-fg)",
        borderTop: "1px solid var(--zero-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Logomark theme={props.theme} size={16} />
        <span>{props.path ?? "no file open"}</span>
        {props.cursor && <span>Ln {props.cursor.line}, Col {props.cursor.column}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusPill engine={props.engine} />
        <button onClick={props.onToggleTheme} style={{ background: "transparent", border: "1px solid var(--zero-border)", color: "inherit", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>
          {props.theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </div>
  );
}
