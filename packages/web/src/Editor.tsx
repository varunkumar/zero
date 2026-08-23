import { useEffect, useRef } from "react";
import { EditorView, keymap, highlightWhitespace, hoverTooltip } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { linter, type Diagnostic as CmDiagnostic, forceLinting } from "@codemirror/lint";
import type { LspDiagnostic, RpcClient, LspHoverResult, LspDefinitionResult } from "@zero/protocol";
import { ghostText } from "./ghostText";
import { ZERO_MONO_FONT } from "./workbench/theme/fonts";
import { ZERO_COLORS } from "./workbench/theme/colors";
import { zeroSyntaxHighlighting } from "./workbench/theme/syntaxHighlighting";

export function toCmDiagnostics(doc: EditorState["doc"], diagnostics: LspDiagnostic[]): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const fromLine = doc.line(Math.min(d.range.start.line + 1, doc.lines));
    const toLine = doc.line(Math.min(d.range.end.line + 1, doc.lines));
    const from = Math.min(fromLine.from + d.range.start.character, doc.length);
    const to = Math.min(toLine.from + d.range.end.character, doc.length);
    const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info";
    return { from, to: Math.max(to, from), severity, message: d.message, source: d.source };
  });
}

// Gutter/selection colors aren't reachable via CSS custom properties (CodeMirror
// renders them through CSSStyleSheet objects, not the document's cascade), so
// the dark/light split is duplicated here rather than read from theme.css vars.
// `.cm-selectionLayer` (drawSelection's custom selection rectangle) paints
// behind `.cm-content` at z-index -1 (see @codemirror/view's LayerView). A
// *solid* `.cm-activeLine` background sitting on the cursor's own line then
// fully occludes that rectangle wherever the two overlap - confirmed by
// inspecting the live DOM: `.cm-selectionBackground` had the right color and
// a correct, non-zero rect, but was invisible in the screenshot specifically
// on the active line. Multi-line selections looked fine because only the
// cursor's own line carries `.cm-activeLine`; the rest have no background to
// occlude anything. Fix: make the active-line wash translucent so it blends
// with (rather than paints over) whatever's beneath it.
const editorTheme = {
  light: [
    EditorView.theme({
      "&": { fontSize: "15px" },
      ".cm-gutters": { backgroundColor: ZERO_COLORS.light.gutterBg, color: ZERO_COLORS.light.gutterFg, border: "none" },
      ".cm-activeLineGutter": { backgroundColor: ZERO_COLORS.light.activeLineGutterBg },
      ".cm-activeLine": { backgroundColor: "rgba(0, 0, 0, 0.035)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(0, 122, 255, 0.28) !important" },
      // highlightWhitespace() renders dots via a radial-gradient background
      // image (not a styleable :before), so the fade has to go into the
      // gradient's color/opacity and a smaller circle, not a color/opacity rule.
      ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, rgba(60, 60, 67, 0.25) 12%, transparent 5%)" },
    }),
    zeroSyntaxHighlighting("light"),
  ],
  dark: [
    EditorView.theme({
      "&": { fontSize: "15px", backgroundColor: ZERO_COLORS.dark.editorBg, color: ZERO_COLORS.dark.editorFg },
      ".cm-content": { caretColor: ZERO_COLORS.dark.cursor },
      ".cm-gutters": { backgroundColor: ZERO_COLORS.dark.gutterBg, color: ZERO_COLORS.dark.gutterFg, border: "none" },
      ".cm-activeLineGutter": { backgroundColor: ZERO_COLORS.dark.activeLineGutterBg },
      ".cm-activeLine": { backgroundColor: "rgba(255, 255, 255, 0.045)" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "rgba(116, 199, 236, 0.32) !important" },
      ".cm-cursor": { borderLeftColor: ZERO_COLORS.dark.cursor },
      ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, rgba(205, 214, 244, 0.22) 12%, transparent 5%)" },
    }, { dark: true }),
    zeroSyntaxHighlighting("dark"),
  ],
};

// CodeMirror's ".cm-editor" root defaults to height:auto, so without an
// explicit height the editor grows to fit its full content instead of
// scrolling internally - the surrounding page scrolls instead. Exported so
// a regression test can assert on it directly without instantiating a view.
export const editorLayoutStyle = {
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
};

const fontTheme = EditorView.theme({
  "&": {
    ...editorLayoutStyle["&"],
    fontFamily: ZERO_MONO_FONT,
  },
  ".cm-scroller": editorLayoutStyle[".cm-scroller"],
  ".cm-content": {
    fontFamily: ZERO_MONO_FONT,
    // font-feature-settings alone (not font-variant-ligatures) is what VS
    // Code's "font ligatures" setting uses too: font-variant-ligatures
    // triggers the browser's text-shaping ligature path, which merges
    // adjacent glyphs in a way that breaks Range.getClientRects() for a
    // selection landing mid-glyph (e.g. selecting one word) - the
    // selection rectangle collapses to zero width. A full-line selection
    // never bisects a glyph, so it looked fine while word selection didn't.
    fontFeatureSettings: "'liga' 1, 'calt' 1",
  },
  // A fixed line-height keeps selection/gutter/line rectangles pixel-aligned;
  // without it the browser's font-dependent default causes visible seams
  // between wrapped selection fragments.
  ".cm-content, .cm-gutters": { lineHeight: "1.6" },
});

export function Editor(props: {
  path: string | null;
  content: string;
  theme?: "light" | "dark";
  onSave: (text: string) => void;
  onChange?: (text: string) => void;
  requestCompletion?: (s: { prefix: string; suffix: string }) => void;
  onViewChange?: (view: EditorView | undefined) => void;
  onCursorChange?: (pos: { line: number; column: number }) => void;
  diagnostics?: LspDiagnostic[];
  client: RpcClient;
  /** When false, skip hover/definition RPC. Defaults true so daemon call sites stay unchanged. */
  lspEnabled?: boolean;
  onGoToDefinition?: (path: string, line: number, character: number) => void;
  /** 1-based line to select and scroll into view. Re-applied whenever this
   * (or `path`) changes, so clicking a second result in an already-open file
   * jumps again even though the view itself isn't rebuilt. */
  goToLine?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  // The dark/light EditorView.theme() is swapped through this compartment
  // rather than causing a full rebuild, so toggling theme doesn't reset
  // cursor position, selection, or undo history.
  const themeCompartment = useRef(new Compartment());
  // Path the currently-live EditorView was created for. Extensions below
  // read callbacks off this ref rather than closing over `props` directly,
  // since the view (and its extensions) can now outlive a single render.
  const propsRef = useRef(props);
  propsRef.current = props;
  const loadedPathRef = useRef<string | null>(null);

  async function goToDefinition(doc: EditorState["doc"], pos: number, line: ReturnType<EditorState["doc"]["lineAt"]>): Promise<void> {
    if (!(propsRef.current.lspEnabled ?? true)) return;
    const position = { line: line.number - 1, character: pos - line.from };
    let result: LspDefinitionResult;
    try {
      result = await propsRef.current.client.request<LspDefinitionResult>(
        "lsp/definition", { path: propsRef.current.path, position });
    } catch {
      return;
    }
    const target = result.locations[0];
    if (target) propsRef.current.onGoToDefinition?.(target.path, target.range.start.line, target.range.start.character);
  }

  // Create the view once per file. Switching files (path changes) is a full
  // rebuild, which is correct: cursor/selection/undo history from file A
  // shouldn't leak into file B. Content changes for the SAME file (e.g. a
  // reconciled external edit) must NOT land here — see the effect below.
  useEffect(() => {
    view.current?.destroy();
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: propsRef.current.content,
        extensions: [
          basicSetup,
          javascript({ typescript: true }),
          themeCompartment.current.of(editorTheme[propsRef.current.theme ?? "light"]),
          fontTheme,
          highlightWhitespace(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => { propsRef.current.onSave(v.state.doc.toString()); return true; },
            },
            {
              key: "F12",
              preventDefault: true,
              run: (v) => {
                const pos = v.state.selection.main.head;
                const line = v.state.doc.lineAt(pos);
                void goToDefinition(v.state.doc, pos, line);
                return true;
              },
            },
            indentWithTab,
          ]),
          ghostText((s) => propsRef.current.requestCompletion?.(s)),
          linter(() => toCmDiagnostics(view.current!.state.doc, propsRef.current.diagnostics ?? [])),
          hoverTooltip(async (view, pos) => {
            if (!(propsRef.current.lspEnabled ?? true)) return null;
            const line = view.state.doc.lineAt(pos);
            const position = { line: line.number - 1, character: pos - line.from };
            let result: LspHoverResult;
            try {
              result = await propsRef.current.client.request<LspHoverResult>(
                "lsp/hover", { path: propsRef.current.path, position });
            } catch {
              return null;
            }
            if (!result.contents) return null;
            return {
              pos, end: pos,
              above: true,
              create: () => {
                const dom = document.createElement("div");
                dom.className = "cm-tooltip-zero-hover";
                dom.textContent = result.contents;
                dom.style.cssText = "max-width: 480px; white-space: pre-wrap; padding: 6px 8px; font-size: 13px;";
                return { dom };
              },
            };
          }),
          EditorView.domEventHandlers({
            mousedown(event, view) {
              if (!(event.metaKey || event.ctrlKey)) return false;
              const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
              if (pos === null) return false;
              event.preventDefault();
              void goToDefinition(view.state.doc, pos, view.state.doc.lineAt(pos));
              return true;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) propsRef.current.onChange?.(u.state.doc.toString());
            if (u.selectionSet || u.docChanged) {
              const pos = u.state.selection.main.head;
              const line = u.state.doc.lineAt(pos);
              propsRef.current.onCursorChange?.({ line: line.number, column: pos - line.from + 1 });
            }
          }),
        ],
      }),
    });
    loadedPathRef.current = props.path;
    propsRef.current.onViewChange?.(view.current);
    return () => {
      view.current?.destroy();
      view.current = undefined;
      propsRef.current.onViewChange?.(undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path]);

  // Content changed while the SAME file stays open (e.g. a reconciled
  // external change to the file on disk). Dispatch a document-replace
  // transaction into the existing view instead of destroying/recreating it,
  // so cursor position, selection, and undo history survive. The mount
  // effect above already handles the initial doc for a newly opened file,
  // so skip this when path just changed too (loadedPathRef !== props.path
  // means the mount effect hasn't caught up yet in this same render pass,
  // or is about to run).
  useEffect(() => {
    if (!view.current) return;
    if (loadedPathRef.current !== props.path) return;
    const current = view.current.state.doc.toString();
    if (current === props.content) return;
    view.current.dispatch({
      changes: { from: 0, to: view.current.state.doc.length, insert: props.content },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content]);

  useEffect(() => {
    if (!view.current) return;
    view.current.dispatch({
      effects: themeCompartment.current.reconfigure(editorTheme[props.theme ?? "light"]),
    });
  }, [props.theme]);

  // Runs after the mount effect above (declaration order), so on a path
  // change it sees the freshly-created view for the new file, not a stale
  // one from the previous file.
  useEffect(() => {
    if (!view.current || props.goToLine == null) return;
    const lineNumber = Math.max(1, Math.min(props.goToLine, view.current.state.doc.lines));
    const line = view.current.state.doc.line(lineNumber);
    view.current.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.path, props.goToLine]);

  // The linter extension above only re-runs on doc changes by default; force
  // a re-lint when diagnostics for the open file change externally (an
  // lsp/diagnostics push unrelated to any local edit).
  useEffect(() => {
    if (view.current) forceLinting(view.current);
  }, [props.diagnostics]);

  return <div ref={host} style={{ height: "100%" }} />;
}
