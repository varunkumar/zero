import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview-react";
import type { EditorView } from "@codemirror/view";
import type { RpcClient, FsReadResult, FsChangedEvent, FsTreeResult, PtyOutputEvent, PtyExitEvent, PtyListResult, LspDiagnostic, LspDiagnosticsEvent } from "@zero/protocol";
import { Editor } from "../../Editor";
import { createCompletion } from "../../completionSetup";
import { CommandRegistry } from "../commands/registry";
import { attachKeybindings } from "../keybindings/dispatcher";
import { TabStore, type Tab } from "../tabs/store";
import { SettingsStore } from "../settings/store";
import { ThemeProvider } from "../theme/ThemeProvider";
import { FileTreePanel } from "../filetree/FileTreePanel";
import { CommandPalette } from "../palette/CommandPalette";
import { FileOpener } from "../palette/FileOpener";
import { SearchPanel } from "../search/SearchPanel";
import { StatusBar } from "../StatusBar";
import { SettingsPanel } from "../settings/SettingsPanel";
import { PtyStore } from "../terminal/store";
import { TerminalPanel } from "../terminal/TerminalPanel";
import "dockview-react/dist/styles/dockview.css";
import "./workbench.css";

const SIDEBAR_PANEL_ID = "sidebar";
const TERMINAL_PANEL_ID = "terminal";
const TERMINAL_SESSIONS_KEY = "zero.terminal.sessionIds";
/** How long a transient status-bar message stays up. */
const STATUS_MESSAGE_MS = 8000;
/** Trailing debounce on tree refreshes: a build or branch switch fires a
 * burst of fs/changed events, and each bump costs two full fs/tree round
 * trips (file tree + file-opener path list). */
const TREE_REFRESH_DEBOUNCE_MS = 250;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const editorPanelId = (groupId: string) => `editor:${groupId}`;

/** Value shared with the dockview-hosted panels.
 *
 * dockview captures a panel's React component **once**, at `addPanel` time
 * (its `createComponent` factory reads `props.components[name]` then, and
 * updating the `components` prop only affects panels created afterwards).
 * So the panel components must be stable module-level functions that read
 * live state from React context rather than inline closures over
 * `Workbench`'s state — those would render forever against the state of the
 * first render. dockview mounts panels through `ReactDOM.createPortal` into
 * its own container, which is rendered inside `DockviewReact`'s JSX, so
 * context from above `<DockviewReact>` does reach them. */
interface WorkbenchContextValue {
  client: RpcClient;
  tabStore: TabStore;
  activeGroupId: string;
  setActiveGroupId: (groupId: string) => void;
  activePath: string | null;
  openFile: (path: string) => void;
  saveTab: (tabId: string) => void;
  /** Close a tab, or - when it is dirty - ask first. Lives on the context so
   * the tab strip's × and the `file.close` command drive the same
   * confirmation instead of one of them closing silently. */
  requestCloseTab: (tabId: string) => void;
  /** Tab currently showing its inline "Discard?" bar, if any. */
  confirmingTabId: string | null;
  cancelCloseTab: () => void;
  setCursor: (cursor: { line: number; column: number }) => void;
  registerView: (groupId: string, view: EditorView | undefined) => void;
  requestCompletion: (s: { prefix: string; suffix: string }) => void;
  sidebarView: "files" | "search";
  setSidebarView: (view: "files" | "search") => void;
  treeRefreshToken: number;
  /** Bumped on every TabStore mutation; unused directly by consumers but part
   * of the context value so a mutation produces a fresh object identity and
   * therefore re-renders every panel. */
  tabsVersion: number;
  theme: "light" | "dark";
  ptyStore: PtyStore;
  diagnosticsByPath: Map<string, LspDiagnostic[]>;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("Workbench panel rendered outside WorkbenchContext");
  return value;
}

function SidebarPanel() {
  const w = useWorkbench();
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)" }}>
      <div className="zero-sidebar-toggle">
        <button aria-pressed={w.sidebarView === "files"} onClick={() => w.setSidebarView("files")}>Files</button>
        <button aria-pressed={w.sidebarView === "search"} onClick={() => w.setSidebarView("search")}>Search</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {w.sidebarView === "files" ? (
          <FileTreePanel client={w.client} activePath={w.activePath} onOpen={w.openFile} refreshToken={w.treeRefreshToken} />
        ) : (
          <SearchPanel client={w.client} onJumpTo={(path) => w.openFile(path)} />
        )}
      </div>
    </div>
  );
}

function TabStrip(props: { groupId: string; tabs: Tab[]; activeTabId: string | null }) {
  const w = useWorkbench();
  // The dirty tab asking to confirm its own close (per the design spec an
  // inline bar in the tab itself, never a modal) is Workbench state, so that
  // the `file.close` command can raise the very same bar.
  const confirmingId = w.confirmingTabId;

  return (
    <div className="zero-tabstrip" role="tablist">
      {props.tabs.map((tab) => {
        const confirming = confirmingId === tab.id && tab.dirty;
        return (
          <div
            key={tab.id}
            className="zero-tab"
            role="tab"
            aria-selected={tab.id === props.activeTabId}
            onClick={() => {
              w.setActiveGroupId(props.groupId);
              w.tabStore.setActiveTab(props.groupId, tab.id);
            }}
          >
            <span>{tab.path.split("/").at(-1)}</span>
            {tab.dirty && <span className="zero-dirty-dot" aria-label="unsaved changes" />}
            {confirming ? (
              <span className="zero-tab-confirm" data-zero-confirm role="group" aria-label={`Discard unsaved changes to ${tab.path}?`}>
                <span>Discard?</span>
                <button
                  aria-label={`Discard changes and close ${tab.path}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    w.cancelCloseTab();
                    w.tabStore.closeTab(tab.id);
                  }}
                >
                  Yes
                </button>
                <button
                  aria-label={`Keep ${tab.path} open`}
                  onClick={(e) => {
                    e.stopPropagation();
                    w.cancelCloseTab();
                  }}
                >
                  No
                </button>
              </span>
            ) : (
              <button
                className="zero-tab-close"
                data-zero-confirm={tab.dirty ? "" : undefined}
                aria-label={`Close ${tab.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // Clean tabs close on a single click, as before; a dirty tab
                  // asks first so unsaved edits can't vanish on a stray click.
                  w.requestCloseTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EditorPanel(props: IDockviewPanelProps<{ groupId: string }>) {
  const w = useWorkbench();
  const groupId = props.params.groupId;
  const group = w.tabStore.getGroups().find((g) => g.id === groupId);
  const tab = group?.tabs.find((t) => t.id === group.activeTabId) ?? null;

  return (
    <div
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)" }}
      onFocusCapture={() => w.setActiveGroupId(groupId)}
      onMouseDown={() => w.setActiveGroupId(groupId)}
    >
      <TabStrip groupId={groupId} tabs={group?.tabs ?? []} activeTabId={group?.activeTabId ?? null} />
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {tab ? (
          <Editor
            path={tab.path}
            content={tab.content}
            theme={w.theme}
            onSave={(text) => {
              w.tabStore.updateContent(tab.id, text);
              w.saveTab(tab.id);
            }}
            onChange={(text) => w.tabStore.updateContent(tab.id, text)}
            onCursorChange={(pos) => {
              if (groupId === w.activeGroupId) w.setCursor(pos);
            }}
            requestCompletion={w.requestCompletion}
            onViewChange={(view) => w.registerView(groupId, view)}
            diagnostics={w.diagnosticsByPath.get(tab.path) ?? []}
          />
        ) : (
          <div style={{ padding: 16, opacity: 0.6 }}>Select a file to edit (Cmd/Ctrl+P)</div>
        )}
      </div>
    </div>
  );
}

function BottomTerminalPanel() {
  const w = useWorkbench();
  return <TerminalPanel client={w.client} ptyStore={w.ptyStore} theme={w.theme} />;
}

/** Stable component map — see the note on WorkbenchContextValue for why this
 * must not be rebuilt per render. */
const DOCKVIEW_COMPONENTS = { sidebar: SidebarPanel, editor: EditorPanel, terminal: BottomTerminalPanel };

/** Ref that initialises exactly once, unlike `useRef(new X())` which
 * constructs a throwaway on every render. */
function useConst<T>(factory: () => T): T {
  const ref = useRef<T>();
  if (ref.current === undefined) ref.current = factory();
  return ref.current;
}

export function Workbench(props: { client: RpcClient }) {
  const { client } = props;
  const registry = useConst(() => new CommandRegistry());
  const tabStore = useConst(() => new TabStore());
  const settingsStore = useConst(() => new SettingsStore(client, window.localStorage));
  const ptyStore = useConst(() => new PtyStore());

  const [settings, setSettings] = useState(() => settingsStore.getSnapshot());
  const [sidebarView, setSidebarView] = useState<"files" | "search">("files");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openerOpen, setOpenerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [treeRefreshToken, setTreeRefreshToken] = useState(0);
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [cursor, setCursor] = useState<{ line: number; column: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ text: string; tone: "error" | "info" } | null>(null);
  const [activeGroupId, setActiveGroupId] = useState("group-1");
  const [tabsVersion, setTabsVersion] = useState(0);
  const [confirmingTabId, setConfirmingTabId] = useState<string | null>(null);
  const [diagnosticsByPath, setDiagnosticsByPath] = useState<Map<string, LspDiagnostic[]>>(new Map());

  const theme = settings.theme;
  const dockApi = useRef<DockviewApi | null>(null);
  // Group ids created by `view.splitEditor`, most recent last; `group-1` is
  // deliberately absent so it can never be closed.
  const splitStack = useRef<string[]>([]);
  // One EditorView per editor group; completions target the focused group's.
  const views = useConst(() => new Map<string, EditorView | undefined>());
  const activeGroupIdRef = useRef(activeGroupId);
  activeGroupIdRef.current = activeGroupId;
  const activePathRef = useRef<string | null>(null);
  // The fs/write we most recently issued, not yet matched against its own
  // fs/changed echo. The daemon's watcher can't tell our writes from external
  // ones, so without this every save would round-trip a re-read.
  const lastWriteRef = useRef<{ path: string; content: string } | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const treeDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  /** Surface an RPC failure in the status bar. Silence is the worst outcome
   * here: a failed fs/write otherwise leaves a tab looking merely dirty. */
  function report(text: string, tone: "error" | "info" = "error"): void {
    setStatusMessage({ text, tone });
    clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => setStatusMessage(null), STATUS_MESSAGE_MS);
  }
  const reportRef = useRef(report);
  reportRef.current = report;

  useEffect(() => () => {
    clearTimeout(statusTimerRef.current);
    clearTimeout(treeDebounceRef.current);
  }, []);

  const completion = useConst(() =>
    createCompletion(
      client,
      () => views.get(activeGroupIdRef.current),
      () => activePathRef.current ?? "",
    ),
  );

  useEffect(() => tabStore.subscribe(() => setTabsVersion((v) => v + 1)), [tabStore]);

  const { activeTab, activePath } = useMemo(() => {
    const groups = tabStore.getGroups();
    const group = groups.find((g) => g.id === activeGroupId) ?? groups[0];
    const tab = group?.tabs.find((t) => t.id === group.activeTabId) ?? null;
    return { activeTab: tab, activePath: tab?.path ?? null };
    // tabsVersion is the invalidation signal for TabStore's mutable state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabStore, activeGroupId, tabsVersion]);
  activePathRef.current = activePath;
  const activeTabRef = useRef<Tab | null>(activeTab);
  activeTabRef.current = activeTab;

  // A freshly built EditorView doesn't emit an update, so the status bar
  // would otherwise keep showing the previous file's position until the user
  // moves the caret.
  useEffect(() => {
    setCursor(null);
  }, [activePath]);

  // Settings: hydrate from the daemon, then track updates.
  useEffect(() => {
    const unsubscribe = settingsStore.subscribe((s) => setSettings(s));
    // A daemon that can't serve settings must not take the editor down with
    // it — the local snapshot is already a usable default.
    void settingsStore
      .reconcile()
      .then((s) => setSettings(s))
      .catch((e: unknown) => reportRef.current(`Could not load saved settings: ${errorText(e)}`, "info"));
    return unsubscribe;
  }, [settingsStore]);

  // THE single client.onNotification handler for the whole app. RpcClient
  // stores one handler and a second call silently replaces it, so every
  // consumer of daemon notifications fans out from right here.
  useEffect(() => {
    client.onNotification((method, params) => {
      if (method === "pty/output") {
        const { sessionId, data } = params as PtyOutputEvent;
        ptyStore.handleOutput(sessionId, data);
        return;
      }
      if (method === "pty/exit") {
        const { sessionId } = params as PtyExitEvent;
        ptyStore.handleExit(sessionId);
        return;
      }
      if (method === "lsp/diagnostics") {
        const { path, diagnostics } = params as LspDiagnosticsEvent;
        setDiagnosticsByPath((prev) => {
          const next = new Map(prev);
          next.set(path, diagnostics);
          return next;
        });
        return;
      }
      if (method !== "fs/changed") return;
      const { path } = params as FsChangedEvent;
      clearTimeout(treeDebounceRef.current);
      treeDebounceRef.current = setTimeout(() => setTreeRefreshToken((t) => t + 1), TREE_REFRESH_DEBOUNCE_MS);

      const lastWrite = lastWriteRef.current;
      if (lastWrite && lastWrite.path === path) {
        // Echo of our own save: the file on disk already matches the buffer.
        // Consume the suppression once so a genuine later edit still lands.
        lastWriteRef.current = null;
        return;
      }

      const tab = tabStore.getGroups().flatMap((g) => g.tabs).find((t) => t.path === path);
      // A dirty tab wins over the on-disk change — never silently discard
      // unsaved edits.
      if (!tab || tab.dirty) return;
      void client
        .request<FsReadResult>("fs/read", { path })
        .then((res) => {
          const current = tabStore.findTab(tab.id);
          if (!current || current.tab.dirty) return;
          tabStore.updateContent(tab.id, res.content);
          tabStore.markSaved(tab.id);
        })
        .catch((e: unknown) => reportRef.current(`Could not reload ${path}: ${errorText(e)}`));
    });
  }, [client, tabStore, ptyStore]);

  // Path list backing the fuzzy file opener, refreshed whenever the tree does.
  useEffect(() => {
    let cancelled = false;
    void client
      .request<FsTreeResult>("fs/tree")
      .then((res) => {
        if (cancelled) return;
        setAllPaths(res.entries.filter((e) => e.kind === "file").map((e) => e.path));
      })
      // FileTreePanel renders its own error for the same failure; here the
      // only visible effect would be an empty file opener.
      .catch((e: unknown) => {
        if (!cancelled) reportRef.current(`Could not list files: ${errorText(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [client, treeRefreshToken]);

  // Reattach on mount: ask the daemon which pty sessions are still alive,
  // keep only the ones this browser previously knew about (persisted below),
  // and reveal the terminal panel if any were restored.
  useEffect(() => {
    let cancelled = false;
    void client
      .request<PtyListResult>("pty/list")
      .then((res) => {
        if (cancelled) return;
        let persistedIds: string[] = [];
        try {
          persistedIds = JSON.parse(window.localStorage.getItem(TERMINAL_SESSIONS_KEY) ?? "[]") as string[];
        } catch {
          persistedIds = [];
        }
        const persisted = new Set(persistedIds);
        let restored = false;
        for (const session of res.sessions) {
          if (persisted.has(session.sessionId)) {
            ptyStore.addSession(session);
            restored = true;
          }
        }
        if (restored) actionsRef.current.showTerminalPanel();
      })
      .catch((e: unknown) => reportRef.current(`Could not restore terminals: ${errorText(e)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Persist the session id list on every PtyStore mutation (new terminal,
  // closed terminal, exited terminal) so the reattach effect above can find
  // them again after a reload.
  useEffect(() => ptyStore.subscribe(() => {
    const ids = ptyStore.getSessions().map((s) => s.sessionId);
    window.localStorage.setItem(TERMINAL_SESSIONS_KEY, JSON.stringify(ids));
  }), [ptyStore]);

  // Every open buffer is completion context.
  useEffect(() => {
    completion.buffers.setBuffers(
      tabStore.getGroups().flatMap((g) => g.tabs).map((t) => ({ path: t.path, content: t.content })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completion, tabStore, tabsVersion]);

  function openFile(path: string): void {
    void client
      .request<FsReadResult>("fs/read", { path })
      .then((res) => {
        const groupId = tabStore.getGroups().some((g) => g.id === activeGroupIdRef.current)
          ? activeGroupIdRef.current
          : tabStore.getGroups()[0]!.id;
        tabStore.openFile(groupId, path, res.content);
        setActiveGroupId(groupId);
      })
      .catch((e: unknown) => reportRef.current(`Could not open ${path}: ${errorText(e)}`));
  }

  function saveTab(tabId: string): void {
    const found = tabStore.findTab(tabId);
    if (!found) return;
    const { path, content } = found.tab;
    void client
      .request("fs/write", { path, content })
      .then(() => {
        lastWriteRef.current = { path, content };
        tabStore.markSaved(tabId);
      })
      // The tab correctly stays dirty on failure, which on its own is
      // indistinguishable from "not saved yet" — say so out loud.
      .catch((e: unknown) => reportRef.current(`Could not save ${path}: ${errorText(e)}`));
  }

  /** Close `tabId`, or raise its inline confirm bar when it is dirty. Both
   * the tab strip's × and the `file.close` command go through here, so no
   * entry point can drop unsaved edits without asking. */
  function requestCloseTab(tabId: string): void {
    const found = tabStore.findTab(tabId);
    if (!found) return;
    if (found.tab.dirty) setConfirmingTabId(tabId);
    else tabStore.closeTab(tabId);
  }

  // Any pointer press outside the confirm bar cancels it. `pointerdown`
  // (rather than `click`) can't observe the very click that opened the bar,
  // and the `[data-zero-confirm]` guard keeps the bar's own buttons alive
  // long enough for their click to land.
  useEffect(() => {
    if (!confirmingTabId) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-zero-confirm]")) return;
      setConfirmingTabId(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [confirmingTabId]);

  // A tab that stopped existing (or got saved elsewhere) must not leave a
  // stale confirm bar behind. Recomputed per render, which tabsVersion drives.
  const confirmingStillDirty = confirmingTabId !== null && (tabStore.findTab(confirmingTabId)?.tab.dirty ?? false);
  useEffect(() => {
    if (confirmingTabId && !confirmingStillDirty) setConfirmingTabId(null);
  }, [confirmingTabId, confirmingStillDirty]);

  function splitEditor(): void {
    const api = dockApi.current;
    if (!api) return;
    const fromGroupId = activeGroupIdRef.current;
    const newGroupId = tabStore.splitGroup(fromGroupId);
    api.addPanel({
      id: editorPanelId(newGroupId),
      component: "editor",
      params: { groupId: newGroupId },
      position: { referencePanel: editorPanelId(fromGroupId), direction: "right" },
    });
    splitStack.current.push(newGroupId);
    setActiveGroupId(newGroupId);
  }

  /** Undo of `splitEditor`. workbench.css hides dockview's own tab/close
   * chrome (document tabs come from TabStore), so without this a split is a
   * one-way door. Closes the most recently created split — a stack, rather
   * than focus tracking, keeps repeated split/close symmetric. */
  function closeEditorGroup(): void {
    const api = dockApi.current;
    if (!api) return;
    const groupId = splitStack.current.at(-1);
    // The initial group is never on the stack, so the last editor area can't
    // be closed; TabStore.removeGroup refuses that case as well.
    if (!groupId) return;
    // removeGroup merges this group's tabs into a neighbour, but drops any
    // whose path is already open there. Dropping a dirty one would destroy
    // unsaved edits with no prompt, so refuse the whole close instead.
    const lost = tabStore.dirtyTabsLostOnRemoveGroup(groupId);
    if (lost.length > 0) {
      report(`Cannot close: ${lost.length} unsaved file(s) in this group would be lost; save or close them first`);
      return;
    }
    if (!tabStore.removeGroup(groupId)) return;
    splitStack.current.pop();
    const panel = api.getPanel(editorPanelId(groupId));
    if (panel) api.removePanel(panel);
    views.delete(groupId);
    setActiveGroupId(splitStack.current.at(-1) ?? tabStore.getGroups()[0]!.id);
  }

  function toggleSidebar(): void {
    settingsStore.update({ sidebarCollapsed: !settingsStore.getSnapshot().sidebarCollapsed });
  }

  // Commands are registered once, but must always act on current state, so
  // each `run` hops through this ref rather than closing over a render's
  // values (re-registering per render would also break `attachKeybindings`,
  // which snapshots the key map when it attaches).
  const actions = {
    openPalette: () => setPaletteOpen(true),
    openFileOpener: () => setOpenerOpen(true),
    toggleTheme: () => settingsStore.update({ theme: settingsStore.getSnapshot().theme === "dark" ? "light" : "dark" }),
    // Revealing a sidebar view is pointless if the sidebar is collapsed, so
    // both of these expand it as well.
    showSearch: () => {
      setSidebarView("search");
      if (settingsStore.getSnapshot().sidebarCollapsed) settingsStore.update({ sidebarCollapsed: false });
    },
    showFiles: () => {
      setSidebarView("files");
      if (settingsStore.getSnapshot().sidebarCollapsed) settingsStore.update({ sidebarCollapsed: false });
    },
    saveActive: () => {
      const tab = activeTabRef.current;
      if (tab) saveTab(tab.id);
    },
    closeActive: () => {
      const tab = activeTabRef.current;
      // Same path as clicking the tab's ×: a dirty tab gets the inline
      // confirm bar rather than being discarded from the palette.
      if (tab) requestCloseTab(tab.id);
    },
    openSettings: () => setSettingsOpen(true),
    toggleSidebar,
    splitEditor,
    closeEditorGroup,
    showTerminalPanel: () => {
      const api = dockApi.current;
      if (!api || api.getPanel(TERMINAL_PANEL_ID)) return;
      api.addPanel({
        id: TERMINAL_PANEL_ID, component: "terminal", params: {},
        position: { direction: "below" },
        initialHeight: 240,
      });
    },
    toggleTerminal: () => {
      const api = dockApi.current;
      if (!api) return;
      const panel = api.getPanel(TERMINAL_PANEL_ID);
      if (panel) { api.removePanel(panel); return; }
      actionsRef.current.showTerminalPanel();
    },
    newTerminal: () => {
      actionsRef.current.showTerminalPanel();
      void client.request<{ sessionId: string; shell: string }>("pty/open", { cols: 80, rows: 24 })
        .then((s) => ptyStore.addSession(s))
        .catch((e: unknown) => reportRef.current(`Could not open terminal: ${errorText(e)}`));
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const commands = [
      { id: "palette.commands", title: "Show All Commands", run: () => actionsRef.current.openPalette(), keybinding: "$mod+Shift+KeyP" },
      { id: "palette.files", title: "Go to File", run: () => actionsRef.current.openFileOpener(), keybinding: "$mod+KeyP" },
      { id: "file.save", title: "Save File", run: () => actionsRef.current.saveActive(), keybinding: "$mod+KeyS" },
      // No keybinding: browsers reserve Cmd/Ctrl+W (tab close) and refuse
      // preventDefault, so any such binding would close the browser tab and
      // silently drop unsaved work. Palette-only for now.
      { id: "file.close", title: "Close File", run: () => actionsRef.current.closeActive() },
      { id: "view.search", title: "Show Search", run: () => actionsRef.current.showSearch(), keybinding: "$mod+Shift+KeyF" },
      { id: "view.files", title: "Show Files", run: () => actionsRef.current.showFiles(), keybinding: "$mod+Shift+KeyE" },
      { id: "view.toggleSidebar", title: "Toggle Sidebar", run: () => actionsRef.current.toggleSidebar(), keybinding: "$mod+KeyB" },
      { id: "view.splitEditor", title: "Split Editor", run: () => actionsRef.current.splitEditor(), keybinding: "$mod+Backslash" },
      { id: "view.closeEditorGroup", title: "Close Editor Group", run: () => actionsRef.current.closeEditorGroup(), keybinding: "$mod+Shift+Backslash" },
      { id: "view.toggleTheme", title: "Toggle Theme", run: () => actionsRef.current.toggleTheme() },
      { id: "preferences.open", title: "Preferences: Open Settings", run: () => actionsRef.current.openSettings() },
      { id: "view.toggleTerminal", title: "Toggle Terminal", run: () => actionsRef.current.toggleTerminal(), keybinding: "Control+Backquote" },
      { id: "terminal.new", title: "New Terminal", run: () => actionsRef.current.newTerminal() },
    ];
    for (const command of commands) registry.register(command);
    const detach = attachKeybindings(registry);
    return () => {
      detach();
      for (const command of commands) registry.unregister(command.id);
    };
  }, [registry]);

  function onReady(event: DockviewReadyEvent): void {
    dockApi.current = event.api;
    const snapshot = settingsStore.getSnapshot();
    event.api.addPanel({
      id: SIDEBAR_PANEL_ID,
      component: "sidebar",
      params: {},
      initialWidth: snapshot.sidebarCollapsed ? 0 : snapshot.sidebarWidth,
      // dockview groups default to a 100px floor, which would make "collapse
      // the sidebar" bottom out at a 100px stub.
      minimumWidth: 0,
    });
    event.api.addPanel({
      id: editorPanelId("group-1"),
      component: "editor",
      params: { groupId: "group-1" },
      position: { referencePanel: SIDEBAR_PANEL_ID, direction: "right" },
    });
  }

  // Collapse/expand is a width change on the sidebar panel; dockview owns the
  // real layout so we drive it through the panel api rather than CSS.
  useEffect(() => {
    const panel = dockApi.current?.getPanel(SIDEBAR_PANEL_ID);
    if (!panel) return;
    panel.api.setSize({ width: settings.sidebarCollapsed ? 0 : settings.sidebarWidth });
  }, [settings.sidebarCollapsed, settings.sidebarWidth]);

  // Remember a user-dragged sidebar width (the store debounces persistence).
  // Safe to read dockApi here: DockviewReact is a descendant, so its mount
  // effect (which calls onReady) has already run by the time this one does.
  useEffect(() => {
    const panel = dockApi.current?.getPanel(SIDEBAR_PANEL_ID);
    if (!panel) return;
    const disposable = panel.api.onDidDimensionsChange((e) => {
      const snapshot = settingsStore.getSnapshot();
      if (snapshot.sidebarCollapsed || e.width <= 0) return;
      if (Math.abs(e.width - snapshot.sidebarWidth) < 1) return;
      settingsStore.update({ sidebarWidth: Math.round(e.width) });
    });
    return () => disposable.dispose();
  }, [settingsStore]);

  const contextValue: WorkbenchContextValue = {
    client,
    tabStore,
    activeGroupId,
    setActiveGroupId,
    activePath,
    openFile,
    saveTab,
    requestCloseTab,
    confirmingTabId,
    cancelCloseTab: () => setConfirmingTabId(null),
    setCursor,
    registerView: (groupId, view) => {
      views.set(groupId, view);
    },
    requestCompletion: completion.request,
    sidebarView,
    setSidebarView,
    treeRefreshToken,
    tabsVersion,
    theme,
    ptyStore,
    diagnosticsByPath,
  };

  return (
    <ThemeProvider theme={theme}>
      <WorkbenchContext.Provider value={contextValue}>
        <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <DockviewReact
              className={`zero-dockview ${theme === "dark" ? "dockview-theme-dark" : "dockview-theme-light"}`}
              components={DOCKVIEW_COMPONENTS}
              onReady={onReady}
              disableFloatingGroups
            />
          </div>
          <StatusBar
            engine={completion.engine}
            path={activePath}
            cursor={cursor}
            theme={theme}
            onToggleTheme={() => registry.run("view.toggleTheme")}
            message={statusMessage}
            lspStatus={activePath ? { path: activePath, count: (diagnosticsByPath.get(activePath) ?? []).length } : null}
          />
        </div>
        <CommandPalette registry={registry} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        <FileOpener paths={allPaths} open={openerOpen} onClose={() => setOpenerOpen(false)} onOpen={openFile} />
        {settingsOpen && <SettingsPanel registry={registry} theme={theme} onClose={() => setSettingsOpen(false)} />}
      </WorkbenchContext.Provider>
    </ThemeProvider>
  );
}
