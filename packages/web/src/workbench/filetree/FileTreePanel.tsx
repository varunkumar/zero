import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from "react-arborist";
import type { RpcClient, TreeEntry, FsTreeResult } from "@zero/protocol";
import { iconFor } from "../icons/iconFor";

interface Node {
  id: string;
  name: string;
  kind: "file" | "dir";
  children?: Node[];
}

/** Synthetic id for the not-yet-created row shown while a New File/New
 * Folder name is being typed - never sent in an `fs/*` RPC. */
const DRAFT_ID = "__zero-draft__";

/** Returns a new tree with `draft` inserted as the first child of the node
 * `parentId` (or, when `parentId` is `null`, as the first root) - pure so
 * the create-in-collapsed-folder / create-at-root cases are unit-testable
 * without mounting react-arborist. */
export function insertDraft(roots: Node[], parentId: string | null, draft: Node): Node[] {
  if (parentId === null) return [draft, ...roots];
  return roots.map((n) => {
    if (n.id === parentId) return { ...n, children: [draft, ...(n.children ?? [])] };
    if (n.children) return { ...n, children: insertDraft(n.children, parentId, draft) };
    return n;
  });
}

/** Imperative actions exposed to `Workbench.tsx` so its keybindings
 * (New File, New Folder, Rename, Delete) can act on whatever's currently
 * selected in the tree without duplicating the RPC-calling logic that
 * already lives here for the context menu. */
export interface FileTreeActions {
  newFileInSelectedDir: () => void;
  newFolderInSelectedDir: () => void;
  renameSelected: () => void;
  deleteSelected: () => void;
  /** Whether the file tree DOM subtree currently has focus - used by
   * `Workbench.tsx` to scope the New File/New Folder/Rename/Delete
   * keybindings to when this panel is actually focused, not merely when
   * "Files" is the selected sidebar *view* (which stays true even while
   * typing in the editor, since it's the default). Without this,
   * `$mod+Backspace` for Delete collides with CodeMirror's own
   * word-delete binding. */
  hasFocus: () => boolean;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildTree(entries: TreeEntry[]): Node[] {
  const roots: Node[] = [];
  const byPath = new Map<string, Node>();
  for (const entry of entries) {
    const node: Node = {
      id: entry.path,
      name: entry.path.split("/").at(-1)!,
      kind: entry.kind,
      children: entry.kind === "dir" ? [] : undefined,
    };
    byPath.set(entry.path, node);
    const parentPath = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : null;
    const parent = parentPath ? byPath.get(parentPath) : null;
    if (parent?.children) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The directory a "new file/folder" created from `path` should land in: the
 * node itself when it's a directory, otherwise its parent. `null`/root falls
 * back to the workspace root ("" ). */
export function containingDir(path: string | null, kind: "file" | "dir" | undefined): string {
  if (!path) return "";
  if (kind === "dir") return path;
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** Join a parent directory (possibly "" for the workspace root) and a leaf
 * name into a workspace-relative path. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// The pure RPC-calling actions below are exported so tests can assert the
// exact `fs/*` calls each menu/keybinding action issues without going
// through DOM events (this package has no DOM test shim - see
// FileOpener.test.ts's rankPaths for the same extract-the-logic precedent).

export async function createEntry(client: RpcClient, parentDir: string, kind: "file" | "dir", name: string): Promise<void> {
  await client.request("fs/create", { path: joinPath(parentDir, name), kind });
}

export async function renameEntry(client: RpcClient, path: string, newName: string): Promise<void> {
  // Renaming (unlike creating) never targets `path` itself as a
  // destination directory, so passing "file" here always yields `path`'s
  // parent - correct for renaming a directory too, since a directory's new
  // name still belongs alongside it, one level up.
  const newPath = joinPath(containingDir(path, "file"), newName);
  await client.request("fs/rename", { path, newPath });
}

export async function deleteEntry(client: RpcClient, path: string): Promise<void> {
  await client.request("fs/delete", { path });
}

/** Guards the delete RPC behind a confirmation, matching `TabStrip`'s
 * "ask before discarding" precedent for destructive actions. Returns
 * whether the delete actually ran, so callers can skip the tree refresh
 * when the user backs out. */
export async function confirmAndDelete(
  client: RpcClient,
  path: string,
  confirm: (message: string) => boolean,
): Promise<boolean> {
  if (!confirm(`Delete ${path}? This cannot be undone.`)) return false;
  await deleteEntry(client, path);
  return true;
}

export async function pasteEntry(
  client: RpcClient,
  clipboard: { path: string; mode: "cut" | "copy" },
  targetDir: string,
): Promise<void> {
  const name = clipboard.path.split("/").at(-1)!;
  const newPath = joinPath(targetDir, name);
  await client.request(clipboard.mode === "cut" ? "fs/move" : "fs/copy", { path: clipboard.path, newPath });
}

function MenuItem(props: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div
      role="menuitem"
      aria-disabled={props.disabled}
      onClick={props.disabled ? undefined : props.onClick}
      style={{
        padding: "4px 10px",
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
        borderRadius: 3,
      }}
    >
      {props.children}
    </div>
  );
}

/** Lets the externally-defined `Row` renderer (react-arborist calls it, so
 * it can't take arbitrary extra props) reach state that lives in
 * `FileTreePanel` - the context-menu handler, which path (if any) is armed
 * for delete confirmation, and cancelling an in-progress New File/Folder
 * draft - without recreating `Row` itself every render. */
const RowActionsContext = createContext<{
  onContextMenu: (e: React.MouseEvent, node: NodeApi<Node>) => void;
  confirmingDeletePath: string | null;
  cancelDraft: () => void;
} | null>(null);

/** Inline text input used for both renaming an existing entry and naming a
 * New File/Folder draft - replaces `window.prompt()`, which Tauri's
 * WKWebView on macOS doesn't implement. Enter or losing focus commits;
 * Escape cancels. */
function InlineNameInput(props: { initialValue: string; onSubmit: (value: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape already resolve the edit; guards the blur handler that
  // follows them (Enter/Escape both move focus away) from submitting twice.
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      defaultValue={props.initialValue}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keep this from also reaching Workbench's global New File/Rename/
        // Delete keybindings while the user is typing a name.
        e.stopPropagation();
        if (e.key === "Enter") {
          settledRef.current = true;
          props.onSubmit(e.currentTarget.value);
        } else if (e.key === "Escape") {
          settledRef.current = true;
          props.onCancel();
        }
      }}
      onBlur={(e) => {
        if (settledRef.current) return;
        settledRef.current = true;
        props.onSubmit(e.currentTarget.value);
      }}
      style={{
        flex: 1,
        minWidth: 0,
        font: "inherit",
        color: "var(--zero-editor-fg)",
        background: "var(--zero-editor-bg)",
        border: "1px solid var(--zero-accent)",
        borderRadius: 2,
        padding: "1px 4px",
      }}
    />
  );
}

function Row({ node, style, dragHandle }: NodeRendererProps<Node>) {
  const actions = useContext(RowActionsContext);
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  const isDeleteArmed = actions?.confirmingDeletePath === node.data.id;
  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        paddingLeft: indent + 8,
        paddingRight: 12,
        cursor: node.data.kind === "file" ? "pointer" : "default",
        display: "flex", gap: 6, alignItems: "center",
        background: isDeleteArmed ? "var(--zero-error-bg)" : node.isSelected ? "var(--zero-selection-bg)" : "transparent",
        color: isDeleteArmed ? "var(--zero-error-fg)" : node.isSelected ? "var(--zero-selection-fg)" : "inherit",
      }}
      onClick={() => {
        if (node.isEditing) return;
        if (node.data.kind === "dir") node.toggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // Stop this from also reaching the container's own onContextMenu
        // (the root-level "New File"/"New Folder" menu), which would
        // otherwise fire right after this one for every row right-click.
        e.stopPropagation();
        actions?.onContextMenu(e, node);
      }}
    >
      <img src={iconFor(node.data.name, node.data.kind === "dir")} alt="" width={16} height={16} style={{ flexShrink: 0 }} />
      {node.isEditing ? (
        <InlineNameInput
          initialValue={node.data.name}
          onSubmit={(value) => node.submit(value)}
          onCancel={() => {
            if (node.data.id === DRAFT_ID) actions?.cancelDraft();
            node.reset();
          }}
        />
      ) : isDeleteArmed ? (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Delete {node.data.name}? Click Delete again to confirm.
        </span>
      ) : (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</span>
      )}
    </div>
  );
}

export const FileTreePanel = forwardRef<
  FileTreeActions,
  {
    client: RpcClient;
    activePath: string | null;
    onOpen: (path: string) => void;
    refreshToken: number;
    /** Called after any create/rename/delete/move/copy so the parent can
     * bump whatever token drives `fs/tree` refetches (same one it already
     * bumps on `fs/changed`). */
    onTreeChanged: () => void;
    /** Surfaces a failed `fs/*` RPC to the status bar - mirrors
     * `Workbench.tsx`'s own `report()` helper ("Silence is the worst
     * outcome here"), reused by every create/rename/delete/paste handler
     * below rather than letting a rejection become an unhandled promise
     * rejection with no user-visible feedback. */
    onError: (message: string) => void;
  }
>(function FileTreePanel(props, ref) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 240, height: 500 });
  // `node: null` represents the root/empty-area menu (right-click below the
  // last row, or on an empty tree) - it only offers New File/New Folder/
  // Paste, targeting the workspace root, since there's no entry to rename,
  // delete, cut, or copy.
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeApi<Node> | null } | null>(null);
  const [clipboard, setClipboard] = useState<{ path: string; mode: "cut" | "copy" } | null>(null);
  // The last node selected in the tree (file or directory), independent of
  // `activePath` (which only tracks the *open* file) - keyboard-driven
  // create/rename/delete need this to know what they're acting on.
  const [selected, setSelected] = useState<{ path: string; kind: "file" | "dir" } | null>(null);
  const treeRef = useRef<TreeApi<Node> | null>(null);
  // Not-yet-created New File/New Folder row, rendered via insertDraft below
  // and put into edit mode by the effect that follows. `parentDir` uses the
  // same "" == workspace root convention as containingDir/joinPath.
  const [draft, setDraft] = useState<{ parentDir: string; kind: "file" | "dir" } | null>(null);
  // The path armed for delete - window.confirm() doesn't work in Tauri's
  // WKWebView either, so Delete requires a second, distinct trigger instead
  // of a modal: click/press Delete once to arm, again to actually delete.
  const [confirmingDeletePath, setConfirmingDeletePath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    props.client
      .request<FsTreeResult>("fs/tree")
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setError(null);
      })
      // Without this a failed fs/tree is indistinguishable from an empty
      // workspace.
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, props.refreshToken]);

  // react-arborist's <Tree> renders a fixed-size virtualized list (defaulting
  // to 300x500 if width/height are omitted), so we measure our own container
  // to keep the tree filling the panel as it resizes.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entriesList) => {
      const entry = entriesList[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const data = useMemo(() => {
    const roots = buildTree(entries);
    if (!draft) return roots;
    const draftNode: Node = { id: DRAFT_ID, name: "", kind: draft.kind, children: draft.kind === "dir" ? [] : undefined };
    return insertDraft(roots, draft.parentDir === "" ? null : draft.parentDir, draftNode);
  }, [entries, draft]);

  // Once the draft row above exists in `data`, open its parent (if
  // collapsed) and put it into edit mode - deferred to an effect since
  // react-arborist's TreeApi only picks up the new row after this render
  // commits.
  useEffect(() => {
    if (!draft) return;
    const tree = treeRef.current;
    if (!tree) return;
    if (draft.parentDir !== "") tree.open(draft.parentDir);
    void tree.edit(DRAFT_ID);
  }, [draft]);

  function handleCreate(kind: "file" | "dir", parentDir: string): void {
    setDraft({ parentDir, kind });
  }

  /** `<Tree onRename>` - fires both when a New File/Folder draft's name is
   * submitted (`id === DRAFT_ID`) and when an existing entry is renamed via
   * inline edit, since both go through `node.submit(value)`. */
  async function handleRenameSubmit({ id, name }: { id: string; name: string }): Promise<void> {
    const trimmed = name.trim();
    if (id === DRAFT_ID) {
      const parentDir = draft?.parentDir ?? "";
      const kind = draft?.kind ?? "file";
      setDraft(null);
      if (!trimmed) return;
      try {
        await createEntry(props.client, parentDir, kind, trimmed);
        props.onTreeChanged();
      } catch (e) {
        props.onError(`Could not create ${joinPath(parentDir, trimmed)}: ${errorText(e)}`);
      }
      return;
    }
    if (!trimmed || trimmed === id.split("/").at(-1)) return;
    try {
      await renameEntry(props.client, id, trimmed);
      props.onTreeChanged();
    } catch (e) {
      props.onError(`Could not rename ${id}: ${errorText(e)}`);
    }
  }

  /** First call arms delete confirmation on `path` (shown inline on its
   * row); a second call with the same `path` actually deletes. Replaces
   * `window.confirm()`, which Tauri's WKWebView doesn't implement either. */
  async function handleDelete(path: string): Promise<void> {
    if (confirmingDeletePath !== path) {
      setConfirmingDeletePath(path);
      return;
    }
    setConfirmingDeletePath(null);
    try {
      const didDelete = await confirmAndDelete(props.client, path, () => true);
      if (didDelete) props.onTreeChanged();
    } catch (e) {
      props.onError(`Could not delete ${path}: ${errorText(e)}`);
    }
  }

  async function handlePaste(targetDir: string): Promise<void> {
    if (!clipboard) return;
    try {
      await pasteEntry(props.client, clipboard, targetDir);
      setClipboard(null);
      props.onTreeChanged();
    } catch (e) {
      props.onError(`Could not paste ${clipboard.path}: ${errorText(e)}`);
    }
  }

  useImperativeHandle(ref, () => ({
    newFileInSelectedDir: () => {
      handleCreate("file", containingDir(selected?.path ?? null, selected?.kind));
    },
    newFolderInSelectedDir: () => {
      handleCreate("dir", containingDir(selected?.path ?? null, selected?.kind));
    },
    renameSelected: () => {
      if (selected) void treeRef.current?.edit(selected.path);
    },
    deleteSelected: () => {
      if (selected) void handleDelete(selected.path);
    },
    hasFocus: () => containerRef.current?.contains(document.activeElement) ?? false,
    // selected/handleCreate/etc close over props.client and clipboard, so
    // they must be rebuilt whenever any of those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [selected, props.client, clipboard]);

  // Escape (or selecting something else) disarms a pending delete
  // confirmation without requiring a click back on the same row.
  useEffect(() => {
    if (!confirmingDeletePath) return;
    if (selected?.path !== confirmingDeletePath) {
      setConfirmingDeletePath(null);
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmingDeletePath(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingDeletePath, selected]);

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", width: "100%", background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)" }}
      onContextMenu={(e) => {
        // Only reached for right-clicks on empty space - any row's own
        // onContextMenu already stopped propagation before this fires.
        e.preventDefault();
        setSelected(null);
        setMenu({ x: e.clientX, y: e.clientY, node: null });
      }}
    >
      {error && (
        <div role="alert" style={{ padding: 8, fontSize: 14, color: "var(--zero-error-fg, crimson)" }}>
          Could not load file tree: {error}
        </div>
      )}
      <RowActionsContext.Provider
        value={{
          onContextMenu: (e, node) => {
            setSelected({ path: node.data.id, kind: node.data.kind });
            setMenu({ x: e.clientX, y: e.clientY, node });
          },
          confirmingDeletePath,
          cancelDraft: () => setDraft(null),
        }}
      >
        <Tree
          ref={treeRef}
          data={data}
          openByDefault={false}
          width={size.width}
          height={size.height}
          selection={props.activePath ?? undefined}
          onRename={handleRenameSubmit}
          onSelect={(nodes) => {
            const node = nodes[0];
            if (!node) return;
            setSelected({ path: node.data.id, kind: node.data.kind });
            if (node.data.kind === "file" && node.data.id !== DRAFT_ID) props.onOpen(node.data.id);
          }}
        >
          {Row}
        </Tree>
      </RowActionsContext.Provider>
      {menu && (
        <div
          role="menu"
          style={{
            position: "fixed", left: menu.x, top: menu.y, zIndex: 1000,
            background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
            borderRadius: 4, padding: 4, minWidth: 140,
          }}
          onMouseLeave={() => setMenu(null)}
        >
          {menu.node === null ? (
            <>
              <MenuItem onClick={() => { handleCreate("file", ""); setMenu(null); }}>New File</MenuItem>
              <MenuItem onClick={() => { handleCreate("dir", ""); setMenu(null); }}>New Folder</MenuItem>
              <MenuItem
                disabled={!clipboard}
                onClick={() => {
                  if (!clipboard) return;
                  void handlePaste("");
                  setMenu(null);
                }}
              >
                Paste
              </MenuItem>
            </>
          ) : (
            <>
              {menu.node.data.kind === "dir" && (
                <MenuItem onClick={() => { handleCreate("file", menu.node!.data.id); setMenu(null); }}>New File</MenuItem>
              )}
              {menu.node.data.kind === "dir" && (
                <MenuItem onClick={() => { handleCreate("dir", menu.node!.data.id); setMenu(null); }}>New Folder</MenuItem>
              )}
              <MenuItem onClick={() => { void treeRef.current?.edit(menu.node!.data.id); setMenu(null); }}>Rename</MenuItem>
              <MenuItem onClick={() => { void handleDelete(menu.node!.data.id); setMenu(null); }}>
                {confirmingDeletePath === menu.node.data.id ? "Confirm Delete" : "Delete"}
              </MenuItem>
              <MenuItem onClick={() => { setClipboard({ path: menu.node!.data.id, mode: "cut" }); setMenu(null); }}>Cut</MenuItem>
              <MenuItem onClick={() => { setClipboard({ path: menu.node!.data.id, mode: "copy" }); setMenu(null); }}>Copy</MenuItem>
              <MenuItem
                disabled={!clipboard}
                onClick={() => {
                  if (!clipboard) return;
                  void handlePaste(menu.node!.data.kind === "dir" ? menu.node!.data.id : containingDir(menu.node!.data.id, "file"));
                  setMenu(null);
                }}
              >
                Paste
              </MenuItem>
            </>
          )}
        </div>
      )}
    </div>
  );
});
