import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ApprovalPrompt } from "./ApprovalPrompt";

// Ink attaches its raw-mode stdin listener inside a useEffect, which runs
// asynchronously after the initial render commits. The first stdin.write()
// against a freshly rendered instance must wait a tick first, or Ink has
// nothing listening yet and the keypress is silently dropped.
const tick = () => new Promise((r) => setTimeout(r, 20));

test("renders the tool name and preview", () => {
  const { lastFrame } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: { path: "a.ts" } }} preview="+hello" onResolve={() => {}} />,
  );
  expect(lastFrame()).toContain("fs_write");
  expect(lastFrame()).toContain("+hello");
});

test("pressing y resolves with approved=true", async () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  await tick();
  stdin.write("y");
  expect(resolved).toBe(true);
});

test("pressing n resolves with approved=false", async () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  await tick();
  stdin.write("n");
  expect(resolved).toBe(false);
});

test("pressing escape resolves with approved=false", async () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  await tick();
  stdin.write("\x1b");
  expect(resolved).toBe(false);
});

test("enter resolves with the default (No) selection", async () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  await tick();
  stdin.write("\r");
  expect(resolved).toBe(false);
});

test("left/right arrows toggle the selection, and enter confirms it", async () => {
  let resolved: boolean | undefined;
  const { stdin } = render(
    <ApprovalPrompt call={{ id: "c1", name: "fs_write", args: {} }} preview="" onResolve={(approved) => { resolved = approved; }} />,
  );
  await tick();
  stdin.write("[C"); // right arrow -> "Yes"
  await tick();
  stdin.write("\r");
  expect(resolved).toBe(true);
});
