import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runAgentCli, positionalArgs, parseGatewayPort } from "./agent";
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

test("positionalArgs extracts task and path correctly", () => {
  expect(positionalArgs(["task"])).toEqual(["task"]);
  expect(positionalArgs(["task", "path"])).toEqual(["task", "path"]);
  expect(positionalArgs(["task", "--yes"])).toEqual(["task"]);
  expect(positionalArgs(["task", "--yes", "path"])).toEqual(["task", "path"]);
  expect(positionalArgs(["task", "--session", "id", "path"])).toEqual(["task", "path"]);
  expect(positionalArgs(["task", "--session", "id"])).toEqual(["task"]);
});

test("positionalArgs skips --gateway-port and its value, so bin/zero.ts's server-start branch doesn't mistake the port for the workspace path", () => {
  // Mirrors bin/zero.ts's server-start branch: `positionalArgs(process.argv.slice(2))[0]`.
  // A flag-only invocation like `zero --gateway-port 4000` (no explicit
  // workspace path) must resolve to no positional args at all, not treat
  // the string "--gateway-port" or its value "4000" as the workspace path.
  expect(positionalArgs(["--gateway-port", "4000"])).toEqual([]);
  expect(positionalArgs(["/some/project", "--gateway-port", "4000"])).toEqual(["/some/project"]);
  expect(positionalArgs(["--gateway-port", "4000", "/some/project"])).toEqual(["/some/project"]);
});

test("parseGatewayPort parses a numeric --gateway-port value, and flags a missing/non-numeric one as invalid rather than passing NaN through", () => {
  expect(parseGatewayPort([])).toBeUndefined();
  expect(parseGatewayPort(["--gateway-port", "4000"])).toBe(4000);
  expect(parseGatewayPort(["--gateway-port"])).toBe("invalid"); // no value follows
  expect(parseGatewayPort(["--gateway-port", "not-a-number"])).toBe("invalid");
});

test("bin/zero.ts's path extraction via positionalArgs(rest)[1] correctly gets the path, not the task", () => {
  // This mirrors bin/zero.ts's exact call site: const path = positionalArgs(rest)[1];
  // Ensures that when a task and path are both provided, we extract the path (2nd positional),
  // not the task (1st positional), fixing the original bug.
  const rest = ["some task text", "/some/project/path", "--yes"];
  const path = positionalArgs(rest)[1];
  expect(path).toBe("/some/project/path");
  expect(path).not.toBe("some task text");
});

test("--session <id> resumes an existing session instead of creating a new one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const sessions = new SessionStore(dir);
  const existingId = await sessions.create("existing task");

  await runAgentCli(["second message", "--session", existingId, "--yes"], dir, { providers: [stubProvider("hello!")] });

  const list = await sessions.list();
  expect(list).toHaveLength(1); // no new session was created
  expect(list[0]!.id).toBe(existingId);
});

test("fails gracefully when task is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zero-agent-cli-"));
  const exitCode = await runAgentCli(["--yes"], dir, { providers: [stubProvider("hi")] });
  expect(exitCode).not.toBe(0);
});
