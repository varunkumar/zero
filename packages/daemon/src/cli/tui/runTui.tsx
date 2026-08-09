// packages/daemon/src/cli/tui/runTui.tsx
import React from "react";
import { render } from "ink";
import { createCliContext, createRuntimeForSession, type CliOpts } from "../runtimeFactory";
import { App, type StartMode } from "./App";

export type TuiOpts = CliOpts;

export async function runTui(root: string, start: StartMode, opts: TuiOpts = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('zero requires an interactive terminal; use zero -p "task" --yes for scripting');
    return 1;
  }
  const ctx = createCliContext(root, opts);
  const { waitUntilExit } = render(
    <App
      sessions={ctx.sessions}
      start={start}
      newSessionTitle="New chat"
      createRuntime={(sessionId) => createRuntimeForSession(ctx, sessionId)}
    />,
  );
  await waitUntilExit();
  return 0;
}
