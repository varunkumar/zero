// packages/daemon/src/cli/agent.test.ts
import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runAgentCli, runListModelsCli, positionalArgs, parseGatewayPort, parseModel } from "./agent";
import { SessionStore } from "../sessions";
import { useTempZeroHome } from "../testSupport/zeroHome";
import type { ChatCapableProvider } from "@zero/core";

useTempZeroHome();

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

test("runs a single turn with -p and --yes and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const exitCode = await runAgentCli(["-p", "say hi", "--yes"], dir, { providers: [stubProvider("hello!")] });
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
  const exitCode = await runAgentCli(["-p", "write a.ts", "--no-tty-for-test"], dir, { providers: [gatedProvider] });
  expect(exitCode).not.toBe(0);
});

test("a finished tool call prints as one collapsed line, not a raw JSON dump", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const toolProvider: ChatCapableProvider = {
    ...stubProvider(""),
    async *chat(messages) {
      if (!messages.some((m) => m.role === "tool")) {
        yield { toolCalls: [{ id: "c1", name: "fs_read", args: { path: "a.ts" } }] };
      } else {
        yield { text: "done" };
      }
    },
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  try {
    await runAgentCli(["-p", "read a.ts", "--yes"], dir, { providers: [toolProvider] });
  } finally {
    console.log = originalLog;
  }
  const toolLine = logs.find((l) => l.includes("fs_read"));
  expect(toolLine).toContain("✓ fs_read");
  expect(toolLine).toContain('{"path":"a.ts"}');
  expect(logs.some((l) => l.includes("[tool]"))).toBe(false);
  expect(logs.some((l) => l.includes("[result]"))).toBe(false);
});

test("positionalArgs skips -p and its value, leaving only the workspace path", () => {
  expect(positionalArgs(["-p", "some task text", "/some/project/path", "--yes"])).toEqual(["/some/project/path"]);
  expect(positionalArgs(["-p", "some task text"])).toEqual([]);
});

test("positionalArgs skips --gateway-port and its value, so bin/zero.ts's server-start branch doesn't mistake the port for the workspace path", () => {
  expect(positionalArgs(["--gateway-port", "4000"])).toEqual([]);
  expect(positionalArgs(["/some/project", "--gateway-port", "4000"])).toEqual(["/some/project"]);
  expect(positionalArgs(["--gateway-port", "4000", "/some/project"])).toEqual(["/some/project"]);
});

test("parseGatewayPort parses a numeric --gateway-port value, and flags a missing/non-numeric one as invalid rather than passing NaN through", () => {
  expect(parseGatewayPort([])).toBeUndefined();
  expect(parseGatewayPort(["--gateway-port", "4000"])).toBe(4000);
  expect(parseGatewayPort(["--gateway-port"])).toBe("invalid");
  expect(parseGatewayPort(["--gateway-port", "not-a-number"])).toBe("invalid");
});

test("--session <id> resumes an existing session instead of creating a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const sessions = new SessionStore(dir);
  const existingId = await sessions.create("existing task");

  await runAgentCli(["-p", "second message", "--session", existingId, "--yes"], dir, { providers: [stubProvider("hello!")] });

  const list = await sessions.list();
  expect(list).toHaveLength(1);
  expect(list[0]!.id).toBe(existingId);
});

test("fails gracefully when -p is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const exitCode = await runAgentCli(["--yes"], dir, { providers: [stubProvider("hi")] });
  expect(exitCode).not.toBe(0);
});

test("parseModel reads --model and flags a missing value as invalid", () => {
  expect(parseModel([])).toBeUndefined();
  expect(parseModel(["--model", "llama3.2:latest"])).toBe("llama3.2:latest");
  expect(parseModel(["--model"])).toBe("invalid");
  expect(parseModel(["--model", "--yes"])).toBe("invalid");
});

test("positionalArgs skips --model and its value", () => {
  expect(positionalArgs(["-p", "task", "--model", "llama3.2:latest", "/proj"])).toEqual(["/proj"]);
});

test("runListModelsCli prints installed models with the active one starred", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const fetchImpl = (async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) return new Response(JSON.stringify({ models: [] }));
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "llama3.2:latest" }, { id: "mistral:latest" }] }));
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const code = await runListModelsCli(dir, { fetchImpl });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("llama3.2:latest"))).toBe(true);
    expect(lines.some((l) => l.includes("mistral:latest"))).toBe(true);
    expect(lines.some((l) => l.startsWith("* ") && l.includes("llama3.2:latest"))).toBe(true);
  } finally {
    console.log = orig;
  }
});
