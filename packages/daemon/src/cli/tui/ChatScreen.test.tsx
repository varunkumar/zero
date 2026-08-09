import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ChatScreen } from "./ChatScreen";
import type { AgentRuntime, TurnEvent } from "@zero/core";

function fakeRuntime(events: TurnEvent[]): Pick<AgentRuntime, "sendMessage" | "resolveApproval"> & { resolved: Array<{ id: string; approved: boolean }> } {
  const resolved: Array<{ id: string; approved: boolean }> = [];
  return {
    resolved,
    resolveApproval(id: string, approved: boolean) { resolved.push({ id, approved }); },
    async *sendMessage() {
      for (const e of events) yield e;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// ink-testing-library's stdin.write() delivers its whole argument as a single
// "readable" chunk, and Ink's parse-keypress only recognizes single-character
// chunks as named keys (e.g. "\r" -> return). A multi-character chunk like
// "hello\r" doesn't match any keypress rule, so ink-text-input's onSubmit
// never fires and the raw text (including the "\r") gets typed literally.
// Simulating a real terminal - one keystroke per "data" event, with a tick
// between so React's controlled-input state settles before the next
// keystroke lands - avoids stale-closure interleaving in TextInput's
// onChange handler.
async function typeAndSubmit(stdin: { write: (data: string) => void }, text: string): Promise<void> {
  for (const ch of `${text}\r`) {
    stdin.write(ch);
    await tick();
  }
}

test("renders resumed transcript lines on mount", () => {
  const { lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={["> hi", "hello there"]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> hi");
  expect(frame).toContain("hello there");
});

test("header stays fully visible and the newest lines stay in view when the transcript overflows the terminal height", async () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={manyLines} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  const frame = lastFrame() ?? "";
  // The header (logo + version line) must never scroll out of view, no
  // matter how long the transcript grows.
  expect(frame).toContain("v0.0.0-test");
  // The most recent message must be visible...
  expect(frame).toContain("line 39");
  // ...and the oldest ones must be dropped from view rather than pushing
  // the header/footer off-screen or growing the frame past the terminal.
  expect(frame).not.toContain("line 0 ");
  const frameHeight = frame.split("\n").length;
  expect(frameHeight).toBeLessThan(24);
});

test("a long, unbroken assistant reply does not corrupt the header or footer layout", async () => {
  const longText = "This is a very long assistant reply that wraps across several terminal rows because it exceeds the terminal width easily and keeps going on and on. ".repeat(3);
  const runtime = fakeRuntime([
    { type: "text", delta: longText },
    { type: "done", message: { role: "assistant", content: longText, createdAt: 0 } },
  ]);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "hi");
  await tick();
  const frame = lastFrame() ?? "";
  // The header banner must render intact (all border rows present, none
  // squeezed out by the wrapped content below it)...
  const borderTopCount = (frame.match(/╭/g) ?? []).length;
  const borderBottomCount = (frame.match(/╰/g) ?? []).length;
  expect(borderTopCount).toBe(borderBottomCount);
  expect(frame).toContain("v0.0.0-test");
  // ...and the footer's input box must render as its own clean bordered
  // box, not merged with overflowing transcript text on the same line.
  expect(frame).toMatch(/╰─+╯/);
});

test("PageUp scrolls the transcript into history, PageDown returns to the live tail", async () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={manyLines} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  expect(lastFrame() ?? "").toContain("line 39");

  stdin.write("\x1b[5~"); // PageUp
  await tick();
  let frame = lastFrame() ?? "";
  expect(frame).toContain("scrolled up");
  expect(frame).not.toContain("line 39");

  stdin.write("\x1b[6~"); // PageDown
  await tick();
  frame = lastFrame() ?? "";
  expect(frame).toContain("line 39");
  expect(frame).not.toContain("scrolled up");
});

test("submitting input streams assistant text into the transcript", async () => {
  const runtime = fakeRuntime([
    { type: "text", delta: "hi " },
    { type: "text", delta: "there" },
    { type: "done", message: { role: "assistant", content: "hi there", createdAt: 0 } },
  ]);
  const { stdin, lastFrame } = render(<ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />);
  await tick();
  await typeAndSubmit(stdin, "hello");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> hello");
  expect(frame).toContain("hi there");
});

test("an approvalRequest renders the prompt, and 'y' resolves it via runtime.resolveApproval", async () => {
  const runtime = fakeRuntime([
    { type: "approvalRequest", call: { id: "c1", name: "fs_write", args: {} }, preview: "+x" },
    { type: "done", message: { role: "assistant", content: "", createdAt: 0 } },
  ]);
  const { stdin, lastFrame } = render(<ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />);
  await tick();
  await typeAndSubmit(stdin, "write it");
  await tick();
  expect(lastFrame() ?? "").toContain("fs_write");
  stdin.write("y");
  await tick();
  expect(runtime.resolved).toEqual([{ id: "c1", approved: true }]);
});

test("onFirstMessage fires exactly once, with the first submitted text", async () => {
  const runtime = fakeRuntime([
    { type: "done", message: { role: "assistant", content: "ok", createdAt: 0 } },
  ]);
  const calls: string[] = [];
  const { stdin } = render(
    <ChatScreen
      runtime={runtime}
      sessionId="s1"
      initialLines={[]}
      cwd="/tmp/proj"
      version="0.0.0-test"
      onFirstMessage={(text) => calls.push(text)}
    />,
  );
  await tick();
  await typeAndSubmit(stdin, "first message");
  await tick();
  expect(calls).toEqual(["first message"]);

  await typeAndSubmit(stdin, "second message");
  await tick();
  expect(calls).toEqual(["first message"]);
});

test("typing '/' shows a filtered command autocomplete", async () => {
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  stdin.write("/");
  await tick();
  let frame = lastFrame() ?? "";
  expect(frame).toContain("/help");
  expect(frame).toContain("/theme");
  expect(frame).toContain("/exit");
  expect(frame).toContain("/quit");

  stdin.write("e");
  await tick();
  frame = lastFrame() ?? "";
  expect(frame).toContain("/exit");
  expect(frame).not.toContain("/help");
  expect(frame).not.toContain("/quit");
});

test("/help lists commands instead of sending a message", async () => {
  const runtime = fakeRuntime([]);
  let sent = false;
  const originalSendMessage = runtime.sendMessage.bind(runtime);
  runtime.sendMessage = (...args: Parameters<typeof originalSendMessage>) => {
    sent = true;
    return originalSendMessage(...args);
  };
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "/help");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("/exit  exit zero");
  expect(sent).toBe(false);
});

test("/theme toggles the theme instead of sending a message", async () => {
  const runtime = fakeRuntime([]);
  let sent = false;
  const originalSendMessage = runtime.sendMessage.bind(runtime);
  runtime.sendMessage = (...args: Parameters<typeof originalSendMessage>) => {
    sent = true;
    return originalSendMessage(...args);
  };
  const { stdin } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "/theme");
  await tick();
  expect(sent).toBe(false);
});

test("a completed tool call collapses into a single summary line, not raw call/result lines", async () => {
  const runtime = fakeRuntime([
    { type: "toolCall", call: { id: "c1", name: "run_command", args: { command: "echo hi" } } },
    { type: "toolResult", call: { id: "c1", name: "run_command", args: { command: "echo hi" } }, result: "hi" },
    { type: "done", message: { role: "assistant", content: "", createdAt: 0 } },
  ]);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "run it");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("✓ run_command");
  expect(frame).toContain("hi");
  expect(frame).not.toContain("[tool]");
  expect(frame).not.toContain("[result]");
});
