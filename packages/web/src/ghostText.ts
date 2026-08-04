import { Prec } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType, keymap } from "@codemirror/view";
import { suggestionField, setSuggestion, clearSuggestion, acceptWord } from "./suggestionState";
export { suggestionField, setSuggestion, clearSuggestion, acceptWord };

class GhostWidget extends WidgetType {
  constructor(private text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ghost";
    span.style.opacity = "0.45";
    span.textContent = this.text;
    return span;
  }
}

const ghostDecoration = EditorView.decorations.compute(
  [suggestionField, "selection"],
  (state): DecorationSet => {
    const text = state.field(suggestionField);
    if (!text) return Decoration.none;
    return Decoration.set([
      Decoration.widget({ widget: new GhostWidget(text), side: 1 })
        .range(state.selection.main.head),
    ]);
  });

function insert(view: EditorView, text: string, remainder: string | null) {
  const pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    effects: remainder ? setSuggestion.of(remainder) : clearSuggestion.of(null),
  });
}

const ghostKeymap = Prec.highest(keymap.of([
  { key: "Tab", run: (v) => { const s = v.state.field(suggestionField); if (!s) return false; insert(v, s, null); return true; } },
  { key: "Alt-ArrowRight", run: (v) => { const s = v.state.field(suggestionField); if (!s) return false; const { take, rest } = acceptWord(s); insert(v, take, rest || null); return true; } },
  { key: "Escape", run: (v) => { if (!v.state.field(suggestionField)) return false; v.dispatch({ effects: clearSuggestion.of(null) }); return true; } },
]));

export function ghostText(requestCompletion: (s: { prefix: string; suffix: string }) => void) {
  const trigger = EditorView.updateListener.of((u) => {
    if (!u.docChanged) return;
    const pos = u.state.selection.main.head;
    requestCompletion({
      prefix: u.state.doc.sliceString(0, pos),
      suffix: u.state.doc.sliceString(pos),
    });
  });
  return [suggestionField, ghostDecoration, ghostKeymap, trigger];
}
