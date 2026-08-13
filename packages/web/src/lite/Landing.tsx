import { Logomark } from "../workbench/theme/Logomark";

export interface LandingProps {
  hasPicker: boolean;
  pending?: { id: string; name: string };
  onOpen: () => void;
  onReopen?: () => void;
}

/** Boot screen for Lite mode: no daemon session exists yet, so this is
 * rendered before any workspace connection is made. Offers to open a new
 * folder, or reopen the last one if permission needs re-confirming. */
export function Landing(props: LandingProps) {
  const theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        height: "100%",
        background: "var(--zero-editor-bg)",
        color: "var(--zero-editor-fg)",
        textAlign: "center",
        padding: 16,
      }}
    >
      <Logomark theme={theme} size={40} />
      <h1 style={{ margin: 0, fontSize: 22 }}>Zero Lite</h1>
      <p style={{ margin: 0, maxWidth: 360, opacity: 0.8 }}>
        Open a local folder in the browser. Chrome or Edge with Gemini Nano required.
      </p>
      {props.hasPicker ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
          <button
            onClick={props.onOpen}
            style={{
              background: "var(--zero-accent)",
              color: "var(--zero-accent-fg)",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Open folder
          </button>
          {props.pending && (
            <button
              onClick={props.onReopen}
              style={{
                background: "transparent",
                color: "var(--zero-accent)",
                border: "1px solid var(--zero-accent)",
                borderRadius: 6,
                padding: "8px 16px",
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Reopen {props.pending.name}
            </button>
          )}
        </div>
      ) : (
        <p style={{ margin: 0, color: "var(--zero-error-fg)" }}>Chrome or Edge is required for Zero Lite.</p>
      )}
    </div>
  );
}
