import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "./ApprovalPrompt";

test("renders the tool name and preview", () => {
  const { lastFrame } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: { path: "a.ts" } }} preview="+hello" onResolve={() => {}} />,
  );
  expect(lastFrame()).toContain("fs_write");
  expect(lastFrame()).toContain("+hello");
});

test("pressing y resolves with approved=true", () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  stdin.write("y");
  expect(resolved).toBe(true);
});

test("pressing n resolves with approved=false", () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  stdin.write("n");
  expect(resolved).toBe(false);
});

test("pressing escape resolves with approved=false", () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  stdin.write("");
  expect(resolved).toBe(false);
});
