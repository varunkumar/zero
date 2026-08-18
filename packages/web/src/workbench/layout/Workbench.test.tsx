import "../../testUtils/domTestSetup";
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RpcClient, WorkspaceCapabilities } from "@zero/protocol";
import { BottomPanel, EditorPanel, TabStrip, WorkbenchContext, getBottomPanelAction, isBinaryFileKind, liteCommandsEnabled } from "./Workbench";
import { PtyStore } from "../terminal/store";
import { ChatStore } from "../chat/store";
import { TurnStore } from "../chat/turnStore";
import { TabStore } from "../tabs/store";
import { iconFor } from "../icons/iconFor";

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

const ALL_CAPABILITIES: WorkspaceCapabilities = {
  pty: true,
  lsp: true,
  graph: true,
  git: true,
  models: ["nano"],
};

function renderBottomPanel(bottomView: "terminal" | "chat", capabilities: WorkspaceCapabilities = ALL_CAPABILITIES) {
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
    closeBottomPanel: () => {},
    capabilities,
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
    // Each toggle button now renders an icon before its label, so assertions
    // below check "which </button> chunk contains this label", rather than
    // relying on the label sitting directly after a `>`.
    const buttons = html.split("</button>");
    const terminalButton = buttons.find((b) => b.endsWith("Terminal"));
    const chatButton = buttons.find((b) => b.endsWith("Chat"));
    expect(terminalButton).toBeDefined();
    expect(chatButton).toBeDefined();
    // An empty PtyStore renders TerminalPanel's empty state, not ChatPanel's.
    expect(html).toContain("No terminals open");
    // Positive assertion: Terminal button should have aria-pressed="true"
    expect(terminalButton).toContain("aria-pressed=\"true\"");
    // Negative assertion: Chat button should not have aria-pressed="true"
    expect(chatButton).not.toContain("aria-pressed=\"true\"");
  });

  test("swapping bottomView to chat keeps TerminalPanel mounted but hidden, and shows ChatPanel", () => {
    const html = renderBottomPanel("chat");
    // Both TerminalPanel and ChatPanel stay mounted at all times (toggled via
    // CSS `display`, not a ternary) so switching tabs never disposes the live
    // xterm instance or drops its PtyStore output subscription. So
    // TerminalPanel's "No terminals open" copy is still present in the
    // markup - it's just inside a `display:none` wrapper - unlike
    // SidebarPanel's Files/Search, which really do mount only one at a time.
    expect(html).toContain("No terminals open");
    expect(html).toContain("display:none");
    const buttons = html.split("</button>");
    const terminalButton = buttons.find((b) => b.endsWith("Terminal"));
    const chatButton = buttons.find((b) => b.endsWith("Chat"));
    expect(chatButton).toContain("aria-pressed=\"true\"");
    // Also check that Terminal is not pressed in this state
    expect(terminalButton).not.toContain("aria-pressed=\"true\"");
  });

  test("BottomPanel hides the Terminal toggle when pty is false", () => {
    const html = renderBottomPanel("chat", { pty: false, lsp: false, graph: false, git: false, models: ["nano"] });
    const buttons = html.split("</button>");
    expect(buttons.find((b) => b.endsWith("Terminal"))).toBeUndefined();
    expect(buttons.find((b) => b.endsWith("Chat"))).toBeDefined();
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

describe("liteCommandsEnabled", () => {
  test("is true only when pty is off", () => {
    expect(liteCommandsEnabled({ pty: false, lsp: false, graph: false, git: false, models: ["nano"] })).toBe(true);
    expect(liteCommandsEnabled({ pty: true, lsp: true, graph: true, git: true, models: ["nano", "openai-compat"] })).toBe(false);
  });
});

function renderTabStrip(tabs: Array<{ id: string; path: string; dirty: boolean }>, activeTabId: string | null = null) {
  // TabStrip only reads a subset of WorkbenchContextValue; the test doesn't
  // need to provide the full value.
  const contextValue = {
    confirmingTabId: null,
    cancelCloseTab: () => {},
    setActiveGroupId: () => {},
    tabStore: {
      setActiveTab: () => {},
    },
  };
  return renderToStaticMarkup(
    <WorkbenchContext.Provider value={contextValue as any}>
      <TabStrip groupId="group-1" tabs={tabs as any} activeTabId={activeTabId} />
    </WorkbenchContext.Provider>,
  );
}

describe("TabStrip", () => {
  test("editor tabs render a file-type icon matching iconFor", () => {
    const html = renderTabStrip([
      { id: "tab-1", path: "src/index.ts", dirty: false },
    ], "tab-1");
    const filename = "index.ts";
    const expectedIconSrc = iconFor(filename, false);
    // Check that an img element with the correct src is rendered
    expect(html).toContain(`<img src="${expectedIconSrc}"`);
  });
});

// Task 9: EditorPanel now switches which viewer it renders based on
// classifyFile(tab.path) - CodeMirror for text, a 50/50 CodeMirror+
// MarkdownPreview split for markdown, and dedicated binary viewers for
// image/pdf. fakeClient.request always rejects (see above), so ImageViewer
// and PdfViewer never leave their initial "loading" state during a
// synchronous renderToStaticMarkup pass - enough to prove routing without
// waiting out their fetch effects.
function renderEditorPanel(path: string) {
  const tabStore = new TabStore();
  tabStore.openFile("group-1", path, "# hello");
  const contextValue = {
    client: fakeClient,
    tabStore,
    theme: "dark" as const,
    diagnosticsByPath: new Map(),
    setActiveGroupId: () => {},
    setCursor: () => {},
    registerView: () => {},
    requestCompletion: () => {},
    capabilities: ALL_CAPABILITIES,
    openFile: () => {},
  };
  return renderToStaticMarkup(
    <WorkbenchContext.Provider value={contextValue as any}>
      <EditorPanel params={{ groupId: "group-1" }} api={{} as any} containerApi={{} as any} />
    </WorkbenchContext.Provider>,
  );
}

describe("EditorPanel viewer routing", () => {
  test("renders the CodeMirror host for a .ts file", () => {
    const html = renderEditorPanel("a.ts");
    expect(html).not.toContain("zero-markdown-preview");
  });

  test("renders a markdown split with a live preview for a .md file", () => {
    const html = renderEditorPanel("a.md");
    expect(html).toContain("zero-markdown-preview");
    expect(html).toContain("<h1>hello</h1>");
  });

  test("renders ImageViewer (loading state) for a .png file, skipping CodeMirror", () => {
    const html = renderEditorPanel("a.png");
    expect(html).toContain("Loading image");
  });

  test("renders PdfViewer (loading state) for a .pdf file, skipping CodeMirror", () => {
    const html = renderEditorPanel("a.pdf");
    expect(html).toContain("Loading PDF");
  });
});

describe("isBinaryFileKind", () => {
  test("is true only for image/pdf paths", () => {
    expect(isBinaryFileKind("a.png")).toBe(true);
    expect(isBinaryFileKind("a.pdf")).toBe(true);
    expect(isBinaryFileKind("a.md")).toBe(false);
    expect(isBinaryFileKind("a.ts")).toBe(false);
  });
});
