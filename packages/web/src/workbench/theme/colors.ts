/**
 * Color literals shared by CodeMirror's EditorView.theme() and xterm's
 * ITheme, both of which need plain JS color values rather than CSS custom
 * properties (see the comment in Editor.tsx explaining why). These values
 * must be kept in sync with the corresponding --zero-* properties in
 * theme.css by hand — there is no automated link between the two.
 */
export const ZERO_COLORS = {
  dark: {
    editorBg: "#1e1e2e",
    editorFg: "#cdd6f4",
    gutterBg: "#181825",
    gutterFg: "#6c7086",
    activeLineGutterBg: "#313244",
    cursor: "#cdd6f4",
  },
  light: {
    editorBg: "#ffffff",
    editorFg: "#1e1e2e",
    gutterBg: "#f5f5f7",
    gutterFg: "#6e6e73",
    activeLineGutterBg: "#e5e5ea",
    cursor: "#1e1e2e",
  },
} as const;
