import { describe, expect, test } from "bun:test";
import { detectMessageFormat, estimateBlockRows, estimateTextRows, parseBlocks, prepareMessageForTranscript } from "./markdown";

describe("parseBlocks", () => {
  test("plain text with no fences is a single text block", () => {
    expect(parseBlocks("just some prose")).toEqual([{ kind: "text", content: "just some prose" }]);
  });

  test("splits prose around a fenced code block, keeping the language tag", () => {
    const text = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(parseBlocks(text)).toEqual([
      { kind: "text", content: "before\n" },
      { kind: "code", lang: "ts", lines: ["const x = 1;"] },
      { kind: "text", content: "\nafter" },
    ]);
  });

  test("code block with no language tag", () => {
    const text = "```\necho hi\n```";
    expect(parseBlocks(text)).toEqual([{ kind: "code", lang: "", lines: ["echo hi"] }]);
  });

  test("multiple code blocks in one message", () => {
    const text = "```js\na\n```\nmiddle\n```py\nb\n```";
    expect(parseBlocks(text)).toEqual([
      { kind: "code", lang: "js", lines: ["a"] },
      { kind: "text", content: "\nmiddle\n" },
      { kind: "code", lang: "py", lines: ["b"] },
    ]);
  });
});

describe("estimateBlockRows / estimateTextRows", () => {
  test("a code block costs one row per line plus two border rows plus a language-label row", () => {
    const block = { kind: "code" as const, lang: "ts", lines: ["a", "b", "c"] };
    expect(estimateBlockRows(block, 80)).toBe(3 + 2 + 1);
  });

  test("a code block with no language tag skips the label row", () => {
    const block = { kind: "code" as const, lang: "", lines: ["a", "b"] };
    expect(estimateBlockRows(block, 80)).toBe(2 + 2);
  });

  test("plain text rows account for embedded newlines, not just total length", () => {
    // Naively estimating from raw length alone (ignoring "\n") would say
    // this fits in one row at columns=80; it actually renders as three.
    expect(estimateTextRows("a\nb\nc", 80)).toBe(3);
  });

  test("plain text rows account for terminal-width wrapping", () => {
    const longLine = "x".repeat(200);
    expect(estimateTextRows(longLine, 80)).toBe(Math.ceil(200 / 80));
  });

  test("mixed prose + code block sums both parts' row costs", () => {
    const text = "explain:\n```js\nfoo();\nbar();\n```";
    // "explain:\n" -> 2 rows (the line, then the trailing empty line) +
    // code block (2 lines + 2 borders + 1 label) = 5
    expect(estimateTextRows(text, 80)).toBe(2 + 5);
  });
});

describe("detectMessageFormat", () => {
  test("recognizes JSON, XML, HTML, YAML, CSV, and Markdown, falling back to plain", () => {
    expect(detectMessageFormat('{"a": 1}')).toBe("json");
    expect(detectMessageFormat("<note><to>you</to></note>")).toBe("xml");
    expect(detectMessageFormat("<div><p>hi</p></div>")).toBe("html");
    expect(detectMessageFormat("name: zero\nversion: 1\nfeatures:\n  - chat\n  - tui")).toBe("yaml");
    expect(detectMessageFormat("a,b,c\n1,2,3")).toBe("csv");
    expect(detectMessageFormat("# Title\n\nSome text")).toBe("markdown");
    expect(detectMessageFormat("just a normal sentence")).toBe("plain");
  });
});

describe("prepareMessageForTranscript", () => {
  test("fences and pretty-prints JSON so it renders as a code block", () => {
    const { text, format } = prepareMessageForTranscript('{"a":1,"b":2}');
    expect(format).toBe("json");
    expect(text).toBe("```json\n{\n  \"a\": 1,\n  \"b\": 2\n}\n```");
  });

  test("fences XML/YAML/CSV without altering their content", () => {
    expect(prepareMessageForTranscript("a,b\n1,2").text).toBe("```csv\na,b\n1,2\n```");
  });

  test("leaves Markdown and plain text untouched, reporting their format", () => {
    expect(prepareMessageForTranscript("# Title\n\ntext")).toEqual({ text: "# Title\n\ntext", format: "markdown" });
    expect(prepareMessageForTranscript("just prose")).toEqual({ text: "just prose", format: "plain" });
  });

  test("leaves HTML as plain text (a terminal can't render markup)", () => {
    const { text, format } = prepareMessageForTranscript("<div><p>hi</p></div>");
    expect(format).toBe("html");
    expect(text).toBe("<div><p>hi</p></div>");
  });
});
