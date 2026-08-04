import { StateField, StateEffect } from "@codemirror/state";

export const setSuggestion = StateEffect.define<string>();
export const clearSuggestion = StateEffect.define<null>();

export const suggestionField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
      if (e.is(clearSuggestion)) return null;
    }
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
});

export function acceptWord(suggestion: string): { take: string; rest: string } {
  const m = suggestion.match(/^\s*\S+/);
  const take = m ? m[0] : suggestion;
  return { take, rest: suggestion.slice(take.length) };
}
