import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { BottomPanel, WorkbenchContext } from "./Workbench";
import { PtyStore } from "../terminal/store";
import { ChatStore } from "../chat/store";
import { TurnStore } from "../chat/turnStore";

// Task 4: Terminal and Chat now share a single dockview panel (`bottom`)
// instead of being separately stacked, following the same locally-toggled
// pattern the sidebar already uses for Files/Search. BottomPanel reads
// `bottomView`/`setBottomView` off WorkbenchContext, so a fake context value
// is enough to exercise it without the whole Workbench + dockview + RpcClient
// stack.

// client.request is never invoked synchronously during BottomPanel's render
// (TerminalPanel/ChatPanel only call it from effects, which
// renderToStaticMarkup never runs), so a fake that always rejects is enough.
const fakeClient = {
  request: () => Promise.reject(new Error("not implemented in test")),
  onNotification: () => {},
} as unknown as RpcClient;

function renderBottomPanel(bottomView: "terminal" | "chat") {
  const contextValue = {
    client: fakeClient,
    ptyStore: new PtyStore(),
    chatStore: new ChatStore(),
    turnStore: new TurnStore(),
    theme: "dark" as const,
    bottomView,
    setBottomView: () => {},
  };
  return renderToStaticMarkup(
    <WorkbenchContext.Provider value={contextValue as never}>
      <BottomPanel />
    </WorkbenchContext.Provider>,
  );
}

describe("BottomPanel", () => {
  test("shows the Terminal toggle as pressed and renders the terminal view by default", () => {
    const html = renderBottomPanel("terminal");
    expect(html).toContain(">Terminal<");
    expect(html).toContain(">Chat<");
    // An empty PtyStore renders TerminalPanel's empty state, not ChatPanel's.
    expect(html).toContain("No terminals open");
    expect(html).not.toContain("aria-pressed=\"true\">Chat<");
  });

  test("swapping bottomView to chat renders ChatPanel instead of TerminalPanel", () => {
    const html = renderBottomPanel("chat");
    // ChatPanel's empty state has no open sessions; TerminalPanel's
    // terminal-only "No terminals open" copy must not appear once Chat is
    // the active view - the two panels are mutually exclusive, mirroring how
    // SidebarPanel only ever mounts one of Files/Search at a time.
    expect(html).not.toContain("No terminals open");
    expect(html).toContain("aria-pressed=\"true\">Chat<");
  });
});
