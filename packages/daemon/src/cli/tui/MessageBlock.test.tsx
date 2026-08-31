import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TextBlockView } from "./MessageBlock";

test("plain (non-markdown) content renders as a single unstyled line, headings/bullets untouched", () => {
  const { lastFrame } = render(
    <TextBlockView content="# Not a heading\n- not a bullet" line={{ id: "l1", text: "" }} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("# Not a heading");
  expect(frame).toContain("- not a bullet");
});

test("markdown content strips heading markers and bullet markers per line", () => {
  const { lastFrame } = render(
    <TextBlockView content={"# Title\n- one\n- two\nplain line"} line={{ id: "l1", text: "", markdown: true }} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Title");
  expect(frame).not.toContain("# Title");
  expect(frame).toContain("• one");
  expect(frame).toContain("• two");
  expect(frame).toContain("plain line");
});
