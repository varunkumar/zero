import { expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { suggestionField, setSuggestion, acceptWord } from "./suggestionState";

test("suggestion set, cleared on doc change", () => {
  let state = EditorState.create({ doc: "const a = ", extensions: [suggestionField] });
  state = state.update({ effects: setSuggestion.of("1 + 2;") }).state;
  expect(state.field(suggestionField)).toBe("1 + 2;");
  state = state.update({ changes: { from: 10, insert: "x" } }).state;
  expect(state.field(suggestionField)).toBeNull();
});

test("acceptWord splits off the first word", () => {
  expect(acceptWord("foo(bar) baz")).toEqual({ take: "foo(bar)", rest: " baz" });
  expect(acceptWord("  x")).toEqual({ take: "  x", rest: "" });
});
