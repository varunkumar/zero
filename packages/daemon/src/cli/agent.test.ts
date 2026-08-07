import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runAgentCli } from "./agent";
import type { ChatCapableProvider } from "@zero/core";

function stubProvider(reply: string): ChatCapableProvider {
  return {
    id: "stub",
    available: async () => true,
    capabilities: () => ({ id: "stub", contextWindowTokens: 100_000, supportsFim: false }),
    supportsTools: () => true,
    async *complete() {},
    async *chat() { yield { text: reply }; },
  };
}

test("runs a single turn with --yes and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const exitCode = await runAgentCli(["say hi", "--yes"], dir, { providers: [stubProvider("hello!")] });
  expect(exitCode).toBe(0);
});

test("fails fast when approval is required, stdin is not a TTY, and --yes is absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const gatedProvider: ChatCapableProvider = {
    ...stubProvider(""),
    async *chat(messages) {
      if (!messages.some((m) => m.role === "tool")) yield { toolCalls: [{ id: "c1", name: "fs_write", args: { path: "a.ts", content: "x" } }] };
      else yield { text: "done" };
    },
  };
  const exitCode = await runAgentCli(["write a.ts", "--no-tty-for-test"], dir, { providers: [gatedProvider] });
  expect(exitCode).not.toBe(0);
});
