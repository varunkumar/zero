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

test("the newest lines stay in view (header scrolled out) when the transcript overflows the terminal height, and scrolling all the way up brings the header back", async () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={manyLines} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  const frame = lastFrame() ?? "";
  // Live tail: the most recent message is visible...
  expect(frame).toContain("line 39");
  // ...and the header - now just the oldest entry in the same scrollable
  // list as everything else - has scrolled out of view along with the
  // oldest messages, rather than staying pinned and squeezing them out.
  expect(frame).not.toContain("v0.0.0-test");
  expect(frame).not.toContain("line 0 ");
  const frameHeight = frame.split("\n").length;
  expect(frameHeight).toBeLessThan(24);

  // Scrolling all the way up reaches the header, same as any old content.
  for (let i = 0; i < 10; i++) { stdin.write("\x1b[5~"); await tick(); } // Page Up
  expect(lastFrame() ?? "").toContain("v0.0.0-test");
});

test("a long, unbroken assistant reply does not corrupt the header or footer layout", async () => {
  const longText = "This is a very long assistant reply that wraps across several terminal rows because it exceeds the terminal width easily and keeps going on and on. ".repeat(3);
  const runtime = fakeRuntime([
    { type: "text", delta: longText },
    { type: "done", message: { role: "assistant", content: longText, createdAt: 0 }, tokensUsed: 0 },
  ]);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "hi");
  await tick();
  const frame = lastFrame() ?? "";
  // No bordered box (footer input, or a code block if there were one)
  // should render half-open - every top border must have a matching
  // bottom border, not merged with overflowing transcript text.
  const borderTopCount = (frame.match(/╭/g) ?? []).length;
  const borderBottomCount = (frame.match(/╰/g) ?? []).length;
  expect(borderTopCount).toBe(borderBottomCount);
  // The footer's input box must render as its own clean bordered box.
  expect(frame).toMatch(/╰─+╯/);
});

test("Page Up scrolls the transcript into history, Page Down returns to the live tail", async () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={manyLines} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  expect(lastFrame() ?? "").toContain("line 39");

  stdin.write("\x1b[5~"); // Page Up
  await tick();
  let frame = lastFrame() ?? "";
  expect(frame).toContain("scrolled up");
  expect(frame).not.toContain("line 39");

  stdin.write("\x1b[6~"); // Page Down
  await tick();
  frame = lastFrame() ?? "";
  expect(frame).toContain("line 39");
  expect(frame).not.toContain("scrolled up");
});

test("scrolling with Page Up/Down never leaks keystrokes into the message input box", async () => {
  const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={manyLines} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  for (let i = 0; i < 5; i++) { stdin.write("\x1b[5~"); await tick(); } // Page Up x5
  for (let i = 0; i < 3; i++) { stdin.write("\x1b[6~"); await tick(); } // Page Down x3
  const frame = lastFrame() ?? "";
  // ink-text-input inserts any keystroke it doesn't special-case as
  // literal text - the input box must still show only the placeholder
  // prompt, not stray characters from the scroll keys.
  expect(frame).toMatch(/│ >\s*│/);
});

test("Up/Down arrows cycle through submitted message history in the input bar", async () => {
  const runtime = fakeRuntime([
    { type: "done", message: { role: "assistant", content: "ok", createdAt: 0 }, tokensUsed: 0 },
  ]);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "first");
  await tick();
  await typeAndSubmit(stdin, "second");
  await tick();

  // The transcript above already contains "> first" and "> second" from
  // the two submitted turns, so assertions must target the input box's
  // own line specifically (the one bordered by "│ >" ... "│"), not just
  // check the frame as a whole.
  const inputLine = () => (lastFrame() ?? "").split("\n").find((l) => /^│ >/.test(l)) ?? "";

  // Start typing a fresh (unsent) draft, then recall history over it.
  stdin.write("d");
  await tick();
  expect(inputLine()).toContain("> d");

  stdin.write("\x1b[A"); // Up -> most recent submitted message
  await tick();
  expect(inputLine()).toContain("> second");

  stdin.write("\x1b[A"); // Up again -> older message
  await tick();
  expect(inputLine()).toContain("> first");

  stdin.write("\x1b[B"); // Down -> back to "second"
  await tick();
  expect(inputLine()).toContain("> second");

  stdin.write("\x1b[B"); // Down past the newest entry -> restores the draft
  await tick();
  expect(inputLine()).toContain("> d");
});

test("Up/Down history recall works on a resumed session, seeded from initialLines", async () => {
  const runtime = fakeRuntime([]);
  const { stdin, lastFrame } = render(
    <ChatScreen
      runtime={runtime}
      sessionId="s1"
      initialLines={["> what is 2+2?", "2+2 is 4.", "> and 3+3?", "3+3 is 6."]}
      cwd="/tmp/proj"
      version="0.0.0-test"
    />,
  );
  await tick();

  const inputLine = () => (lastFrame() ?? "").split("\n").find((l) => /^│ >/.test(l)) ?? "";

  stdin.write("\x1b[A"); // Up -> most recent resumed user message
  await tick();
  expect(inputLine()).toContain("> and 3+3?");

  stdin.write("\x1b[A"); // Up again -> older resumed user message
  await tick();
  expect(inputLine()).toContain("> what is 2+2?");
});

test("a fenced code block renders as a bordered block with its language tag, not raw backtick fences", async () => {
  const reply = "Here you go:\n```ts\nfunction add(a, b) {\n  return a + b;\n}\n```\nDone.";
  const runtime = fakeRuntime([
    { type: "text", delta: reply },
    { type: "done", message: { role: "assistant", content: reply, createdAt: 0 }, tokensUsed: 0 },
  ]);
  const { stdin, stdout, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  // A default 24-row test terminal doesn't leave enough room below the
  // fixed 16-row header for a 6-row code block - give it more room, the
  // same way a real (taller) terminal would have it.
  Object.defineProperty(stdout, "rows", { value: 45, configurable: true });
  stdout.emit("resize");
  await tick();
  await typeAndSubmit(stdin, "show me");
  await tick();
  const frame = lastFrame() ?? "";
  expect(frame).toContain("Here you go:");
  expect(frame).toContain("ts");
  expect(frame).toContain("function add(a, b) {");
  expect(frame).toContain("return a + b;");
  expect(frame).toContain("Done.");
  expect(frame).not.toContain("```");
});

test("a reply with two code blocks separated by prose renders both, splitting across scroll pages if needed rather than vanishing", async () => {
  const reply = [
    "First snippet:", "```js", "function one() {", "  return 1;", "}", "```",
    "Second snippet:", "```py", "def two():", "    return 2", "```", "That's both.",
  ].join("\n");
  const runtime = fakeRuntime([
    { type: "text", delta: reply },
    { type: "done", message: { role: "assistant", content: reply, createdAt: 0 }, tokensUsed: 0 },
  ]);
  const { stdin, lastFrame } = render(
    <ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} cwd="/tmp/proj" version="0.0.0-test" />,
  );
  await tick();
  await typeAndSubmit(stdin, "show me");
  await tick();
  // Both blocks fit in the default test-terminal height (with the header
  // now scrolled off, unlike before) - no scrolling needed to see them.
  const frame = lastFrame() ?? "";
  expect(frame).toContain("First snippet:");
  expect(frame).toContain("function one() {");
  expect(frame).toContain("Second snippet:");
  expect(frame).toContain("def two():");
  expect(frame).toContain("That's both.");
  // Neither code block renders as a half-open box (no closing border).
  const borderTopCount = (frame.match(/╭/g) ?? []).length;
  const borderBottomCount = (frame.match(/╰/g) ?? []).length;
  expect(borderTopCount).toBe(borderBottomCount);
});

test("resumed transcript distinguishes user and assistant turns", () => {
  const { lastFrame } = render(
    <ChatScreen
      runtime={fakeRuntime([])}
      sessionId="s1"
      initialLines={["> what is 2+2?", "2+2 is 4."]}
      cwd="/tmp/proj"
      version="0.0.0-test"
    />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> what is 2+2?");
  expect(frame).toContain("2+2 is 4.");
});

test("submitting input streams assistant text into the transcript", async () => {
  const runtime = fakeRuntime([
    { type: "text", delta: "hi " },
    { type: "text", delta: "there" },
    { type: "done", message: { role: "assistant", content: "hi there", createdAt: 0 }, tokensUsed: 0 },
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
    { type: "done", message: { role: "assistant", content: "", createdAt: 0 }, tokensUsed: 0 },
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
    { type: "done", message: { role: "assistant", content: "ok", createdAt: 0 }, tokensUsed: 0 },
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

test("/model with no argument opens the model picker instead of sending a message", async () => {
  const runtime = fakeRuntime([]);
  let sent = false;
  const originalSendMessage = runtime.sendMessage.bind(runtime);
  runtime.sendMessage = (...args: Parameters<typeof originalSendMessage>) => {
    sent = true;
    return originalSendMessage(...args);
  };
  const { stdin, lastFrame } = render(
    <ChatScreen
      runtime={runtime}
      sessionId="s1"
      initialLines={[]}
      cwd="/tmp/proj"
      version="0.0.0-test"
      models={["llama3.2:latest", "mistral:latest"]}
      activeModel="llama3.2:latest"
    />,
  );
  await tick();
  await typeAndSubmit(stdin, "/model");
  await tick();
  const frame = lastFrame() ?? "";
  expect(sent).toBe(false);
  expect(frame).toContain("llama3.2:latest");
  expect(frame).toContain("mistral:latest");
  expect(frame).toContain("Pick an Ollama model");
});

test("/model <name> selects that model instead of sending a message", async () => {
  const runtime = fakeRuntime([]);
  let picked: string | undefined;
  const { stdin, lastFrame } = render(
    <ChatScreen
      runtime={runtime}
      sessionId="s1"
      initialLines={[]}
      cwd="/tmp/proj"
      version="0.0.0-test"
      models={["llama3.2:latest", "mistral:latest"]}
      activeModel="llama3.2:latest"
      onSelectModel={(name) => { picked = name; }}
    />,
  );
  await tick();
  await typeAndSubmit(stdin, "/model mistral:latest");
  await tick();
  expect(picked).toBe("mistral:latest");
  expect(lastFrame() ?? "").toContain("model: mistral:latest");
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
    { type: "done", message: { role: "assistant", content: "", createdAt: 0 }, tokensUsed: 0 },
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
