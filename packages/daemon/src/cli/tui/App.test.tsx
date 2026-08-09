// packages/daemon/src/cli/tui/App.test.tsx
import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./App";
import { SessionStore } from "../../sessions";
import { useTempZeroHome } from "../../testSupport/zeroHome";
import type { AgentRuntime, TurnEvent } from "@zero/core";

useTempZeroHome();

function fakeRuntime(): Pick<AgentRuntime, "sendMessage" | "resolveApproval"> {
  return {
    resolveApproval() {},
    async *sendMessage(): AsyncIterable<TurnEvent> {},
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("'new' start mode creates a session and goes straight to the chat screen", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-app-"));
  const sessions = new SessionStore(root);
  render(
    <App sessions={sessions} start={{ kind: "new" }} newSessionTitle="New chat" createRuntime={() => fakeRuntime() as AgentRuntime} />,
  );
  await tick();
  const list = await sessions.list();
  expect(list).toHaveLength(1);
});

test("'resume' start mode with sessions shows the picker listing them", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-app-"));
  const sessions = new SessionStore(root);
  await sessions.create("Earlier chat");
  const { lastFrame } = render(
    <App sessions={sessions} start={{ kind: "resume" }} newSessionTitle="New chat" createRuntime={() => fakeRuntime() as AgentRuntime} />,
  );
  await tick();
  expect(lastFrame() ?? "").toContain("Earlier chat");
});

test("'session' start mode with an unknown id shows an error instead of crashing", async () => {
  const root = mkdtempSync(join(tmpdir(), "zero-app-"));
  const sessions = new SessionStore(root);
  const { lastFrame } = render(
    <App
      sessions={sessions}
      start={{ kind: "session", sessionId: "11111111-1111-4111-8111-111111111111" }}
      newSessionTitle="New chat"
      createRuntime={() => fakeRuntime() as AgentRuntime}
    />,
  );
  await tick();
  expect(lastFrame() ?? "").toContain("error");
});
