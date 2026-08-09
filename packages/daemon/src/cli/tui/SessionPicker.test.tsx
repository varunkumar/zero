import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { SessionPicker } from "./SessionPicker";

const sessions = [
  { id: "s1", title: "Fix bug", updatedAt: Date.parse("2026-08-09T10:00:00Z"), messageCount: 4 },
  { id: "s2", title: "Add feature", updatedAt: Date.parse("2026-08-08T10:00:00Z"), messageCount: 2 },
];

test("lists 'New session' plus each existing session's title", () => {
  const { lastFrame } = render(<SessionPicker sessions={sessions} onSelect={() => {}} cwd="/tmp/proj" />);
  const frame = lastFrame() ?? "";
  expect(frame).toContain("New session");
  expect(frame).toContain("Fix bug");
  expect(frame).toContain("Add feature");
});

// Ink attaches its raw-mode stdin listener inside a useEffect, which runs
// asynchronously after the initial render commits. The first stdin.write()
// against a freshly rendered instance must wait a tick first, or Ink has
// nothing listening yet and the keypress is silently dropped.
const tick = () => new Promise((r) => setTimeout(r, 20));

test("enter on the default selection picks 'new'", async () => {
  let picked: string | undefined;
  const { stdin } = render(<SessionPicker sessions={sessions} onSelect={(id) => { picked = id; }} cwd="/tmp/proj" />);
  await tick();
  stdin.write("\r");
  expect(picked).toBe("new");
});

test("down arrow then enter picks the first existing session", async () => {
  let picked: string | undefined;
  const { stdin } = render(<SessionPicker sessions={sessions} onSelect={(id) => { picked = id; }} cwd="/tmp/proj" />);
  await tick();
  stdin.write("\u001B[B");
  await tick();
  stdin.write("\r");
  expect(picked).toBe("s1");
});
