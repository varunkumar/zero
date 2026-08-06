import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { toCmDiagnostics } from "./Editor";

function docFor(text: string) {
  return EditorState.create({ doc: text }).doc;
}

describe("toCmDiagnostics", () => {
  test("converts LSP's 0-based line/character range to CodeMirror's document offsets", () => {
    // "const x: string = 42;" - the type error spans "42" on line 0.
    const doc = docFor("const x: string = 42;\n");
    const [d] = toCmDiagnostics(doc, [{
      range: { start: { line: 0, character: 18 }, end: { line: 0, character: 20 } },
      severity: 1,
      message: "Type 'number' is not assignable to type 'string'.",
    }]);
    expect(doc.sliceString(d!.from, d!.to)).toBe("42");
  });

  test("maps severity 1/2/other to error/warning/info", () => {
    const doc = docFor("a\nb\nc\n");
    const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
    const [error, warning, info] = toCmDiagnostics(doc, [
      { range, severity: 1, message: "e" },
      { range, severity: 2, message: "w" },
      { range, severity: 3, message: "i" },
    ]);
    expect(error!.severity).toBe("error");
    expect(warning!.severity).toBe("warning");
    expect(info!.severity).toBe("info");
  });

  test("clamps a range past the end of the document instead of throwing", () => {
    const doc = docFor("short\n");
    expect(() => toCmDiagnostics(doc, [{
      range: { start: { line: 50, character: 0 }, end: { line: 50, character: 10 } },
      severity: 1,
      message: "stale diagnostic for a line that no longer exists after an edit",
    }])).not.toThrow();
  });
});
