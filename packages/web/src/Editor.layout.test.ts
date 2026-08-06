import { describe, expect, test } from "bun:test";
import { editorLayoutStyle } from "./Editor";

describe("editorLayoutStyle", () => {
  test("constrains the editor root to a bounded height", () => {
    // Regression guard: CodeMirror's .cm-editor root defaults to
    // height:auto, so without this the editor grows to fit its full
    // content and the surrounding page scrolls instead of the editor pane.
    expect(editorLayoutStyle["&"].height).toBe("100%");
  });

  test("lets the scroller overflow internally", () => {
    expect(editorLayoutStyle[".cm-scroller"].overflow).toBe("auto");
  });
});
