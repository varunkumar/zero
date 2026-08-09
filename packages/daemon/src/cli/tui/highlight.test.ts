import { describe, expect, test } from "bun:test";
import { highlightLine } from "./highlight";

function textOf(tokens: ReturnType<typeof highlightLine>): string {
  return tokens.map((t) => t.text).join("");
}

describe("highlightLine", () => {
  test("reassembling the tokens reproduces the original line exactly", () => {
    const line = "  const total = add(1, 2); // sum it up";
    expect(textOf(highlightLine(line))).toBe(line);
  });

  test("colors a known keyword", () => {
    const tokens = highlightLine("const x = 1;");
    const constToken = tokens.find((t) => t.text === "const");
    expect(constToken?.color).toBe("magenta");
  });

  test("does not color an identifier that isn't a keyword", () => {
    const tokens = highlightLine("myVariable();");
    const idToken = tokens.find((t) => t.text === "myVariable");
    expect(idToken?.color).toBeUndefined();
  });

  test("colors a double-quoted string literal", () => {
    const tokens = highlightLine('say("hello")');
    const strToken = tokens.find((t) => t.text === '"hello"');
    expect(strToken?.color).toBe("green");
  });

  test("colors a numeric literal", () => {
    const tokens = highlightLine("x = 42");
    const numToken = tokens.find((t) => t.text === "42");
    expect(numToken?.color).toBe("yellow");
  });

  test("dims a line comment", () => {
    const tokens = highlightLine("x = 1 // trailing comment");
    const commentToken = tokens.find((t) => t.text === "// trailing comment");
    expect(commentToken?.dim).toBe(true);
  });

  test("dims a python-style comment", () => {
    const tokens = highlightLine("x = 1 # trailing comment");
    const commentToken = tokens.find((t) => t.text === "# trailing comment");
    expect(commentToken?.dim).toBe(true);
  });

  test("an empty line still produces at least one token", () => {
    expect(highlightLine("")).toHaveLength(1);
  });
});
