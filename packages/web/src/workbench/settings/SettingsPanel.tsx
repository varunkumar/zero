import type { CommandRegistry } from "../commands/registry";
import { Settings } from "../../Settings";

export function SettingsPanel(props: { registry: CommandRegistry; theme: "light" | "dark"; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 1000 }} onClick={props.onClose}>
      <div
        style={{ background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)", width: 480, maxHeight: "70vh", overflow: "auto", borderRadius: 8, border: "1px solid var(--zero-border)", padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Preferences</h3>
        <h4>Theme</h4>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => props.registry.run("view.toggleTheme")}
            style={{
              flex: 1,
              padding: 8,
              border: `2px solid ${props.theme === "light" ? "var(--zero-accent)" : "var(--zero-border)"}`,
              background: props.theme === "light" ? "var(--zero-accent)" : "transparent",
              color: props.theme === "light" ? "var(--zero-editor-bg)" : "var(--zero-editor-fg)",
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: props.theme === "light" ? 600 : 400,
              fontSize: 14,
            }}
          >
            Light
          </button>
          <button
            onClick={() => props.registry.run("view.toggleTheme")}
            style={{
              flex: 1,
              padding: 8,
              border: `2px solid ${props.theme === "dark" ? "var(--zero-accent)" : "var(--zero-border)"}`,
              background: props.theme === "dark" ? "var(--zero-accent)" : "transparent",
              color: props.theme === "dark" ? "var(--zero-editor-bg)" : "var(--zero-editor-fg)",
              borderRadius: 4,
              cursor: "pointer",
              fontWeight: props.theme === "dark" ? 600 : 400,
              fontSize: 14,
            }}
          >
            Dark
          </button>
        </div>
        <h4>Keybindings</h4>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <tbody>
            {props.registry.list().filter((c) => c.keybinding).map((c) => (
              <tr key={c.id} style={{ borderBottom: "1px solid var(--zero-border)" }}>
                <td style={{ padding: 4 }}>{c.title}</td>
                <td style={{ padding: 4, textAlign: "right", opacity: 0.7 }}>{c.keybinding}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4 style={{ marginTop: 16 }}>Completions</h4>
        <Settings />
      </div>
    </div>
  );
}
