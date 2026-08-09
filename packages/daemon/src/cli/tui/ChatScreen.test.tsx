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
    <ChatScreen runtime={fakeRuntime([])} sessionId="s1" initialLines={["> hi", "hello there"]} />,
  );
  const frame = lastFrame() ?? "";
  expect(frame).toContain("> hi");
  expect(frame).toContain("hello there");
});

test("submitting input streams assistant text into the transcript", async () => {
  const runtime = fakeRuntime([
    { type: "text", delta: "hi " },
    { type: "text", delta: "there" },
    { type: "done", message: { role: "assistant", content: "hi there", createdAt: 0 } },
  ]);
  const { stdin, lastFrame } = render(<ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} />);
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
  const { stdin, lastFrame } = render(<ChatScreen runtime={runtime} sessionId="s1" initialLines={[]} />);
  await tick();
  await typeAndSubmit(stdin, "write it");
  await tick();
  expect(lastFrame() ?? "").toContain("fs_write");
  stdin.write("y");
  await tick();
  expect(runtime.resolved).toEqual([{ id: "c1", approved: true }]);
});
