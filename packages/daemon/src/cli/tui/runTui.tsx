// packages/daemon/src/cli/tui/runTui.tsx
import React from "react";
import { render } from "ink";
import { createCliContext, createRuntimeForSession, type CliOpts } from "../runtimeFactory";
import { App, type StartMode } from "./App";
import { VERSION } from "../../version";

export type TuiOpts = CliOpts;

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
const LEAVE_ALT_SCREEN = "\x1b[?1049l";

export async function runTui(root: string, start: StartMode, opts: TuiOpts = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('zero requires an interactive terminal; use zero -p "task" --yes for scripting');
    return 1;
  }
  const ctx = createCliContext(root, opts);

  // Run the TUI in the terminal's alternate screen buffer, like vim/htop,
  // so it takes over the full window instead of scrolling inline. The
  // "exit" handler is a safety net for abrupt termination (e.g. an
  // uncaught exception) that would otherwise skip the finally block below
  // and leave the user's terminal stuck on the alt screen.
  process.stdout.write(ENTER_ALT_SCREEN);
  const restoreScreen = () => process.stdout.write(LEAVE_ALT_SCREEN);
  process.on("exit", restoreScreen);
  try {
    const { waitUntilExit } = render(
      <App
        sessions={ctx.sessions}
        start={start}
        newSessionTitle="New chat"
        createRuntime={(sessionId) => createRuntimeForSession(ctx, sessionId)}
        cwd={root}
        version={VERSION}
      />,
    );
    await waitUntilExit();
    return 0;
  } finally {
    process.removeListener("exit", restoreScreen);
    restoreScreen();
  }
}
