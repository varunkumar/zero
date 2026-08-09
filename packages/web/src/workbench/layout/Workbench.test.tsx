import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient } from "@zero/protocol";
import { BottomPanel, WorkbenchContext, getBottomPanelAction } from "./Workbench";
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
  // BottomPanel only reads these fields from context; the test doesn't need
  // to provide or type-check the full WorkbenchContextValue.
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
    <WorkbenchContext.Provider value={contextValue as any}>
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
    // Positive assertion: Terminal button should have aria-pressed="true"
    expect(html).toContain("aria-pressed=\"true\">Terminal<");
    // Negative assertion: Chat button should not have aria-pressed="true"
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
    // Also check that Terminal is not pressed in this state
    expect(html).not.toContain("aria-pressed=\"true\">Terminal<");
  });
});

describe("getBottomPanelAction", () => {
  test("(a) opening terminal when nothing is open returns 'add'", () => {
    const action = getBottomPanelAction(false, "terminal", "terminal");
    expect(action).toBe("add");
  });

  test("(a) opening chat when nothing is open returns 'add'", () => {
    const action = getBottomPanelAction(false, "terminal", "chat");
    expect(action).toBe("add");
  });

  test("(b) toggling the same view again while open returns 'remove'", () => {
    const action = getBottomPanelAction(true, "terminal", "terminal");
    expect(action).toBe("remove");
  });

  test("(b) toggling chat when chat is already open returns 'remove'", () => {
    const action = getBottomPanelAction(true, "chat", "chat");
    expect(action).toBe("remove");
  });

  test("(c) switching from terminal to chat while already open returns 'switch'", () => {
    const action = getBottomPanelAction(true, "terminal", "chat");
    expect(action).toBe("switch");
  });

  test("(c) switching from chat to terminal while already open returns 'switch'", () => {
    const action = getBottomPanelAction(true, "chat", "terminal");
    expect(action).toBe("switch");
  });

  test("(d) calling the show action when panel already exists with same view returns 'remove'", () => {
    // showBottomPanel doesn't remove panels directly, but the action tells us
    // the panel already exists, so showBottomPanel won't call addPanel again
    const action = getBottomPanelAction(true, "terminal", "terminal");
    expect(action).toBe("remove");
  });

  test("(d) calling the show action when panel already exists with different view returns 'switch'", () => {
    // showBottomPanel will update the view but won't add the panel again
    const action = getBottomPanelAction(true, "terminal", "chat");
    expect(action).toBe("switch");
  });
});
