import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import type { RpcClient, TreeEntry, FsTreeResult } from "@zero/protocol";
import { iconFor } from "../icons/iconFor";

interface Node {
  id: string;
  name: string;
  kind: "file" | "dir";
  children?: Node[];
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
 * it can't take arbitrary extra props) reach the context-menu handler that
 * lives in `FileTreePanel`'s state, without recreating `Row` itself every
 * render. */
const RowActionsContext = createContext<{
  onContextMenu: (e: React.MouseEvent, node: NodeApi<Node>) => void;
} | null>(null);

function Row({ node, style, dragHandle }: NodeRendererProps<Node>) {
  const actions = useContext(RowActionsContext);
  const indent = typeof style.paddingLeft === "number" ? style.paddingLeft : 0;
  return (
    <div
      ref={dragHandle}
      style={{
        ...style,
        paddingLeft: indent + 8,
        paddingRight: 12,
        cursor: node.data.kind === "file" ? "pointer" : "default",
        display: "flex", gap: 6, alignItems: "center",
        background: node.isSelected ? "var(--zero-selection-bg)" : "transparent",
        color: node.isSelected ? "var(--zero-selection-fg)" : "inherit",
      }}
      onClick={() => {
        if (node.data.kind === "dir") node.toggle();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        actions?.onContextMenu(e, node);
      }}
    >
      <img src={iconFor(node.data.name, node.data.kind === "dir")} alt="" width={16} height={16} style={{ flexShrink: 0 }} />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</span>
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
  }
>(function FileTreePanel(props, ref) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 240, height: 500 });
  const [menu, setMenu] = useState<{ x: number; y: number; node: NodeApi<Node> } | null>(null);
  const [clipboard, setClipboard] = useState<{ path: string; mode: "cut" | "copy" } | null>(null);
  // The last node selected in the tree (file or directory), independent of
  // `activePath` (which only tracks the *open* file) - keyboard-driven
  // create/rename/delete need this to know what they're acting on.
  const [selected, setSelected] = useState<{ path: string; kind: "file" | "dir" } | null>(null);

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

  const data = useMemo(() => buildTree(entries), [entries]);

  async function handleCreate(kind: "file" | "dir", parentDir: string): Promise<void> {
    const name = window.prompt(kind === "file" ? "New file name" : "New folder name");
    if (!name) return;
    await createEntry(props.client, parentDir, kind, name);
    props.onTreeChanged();
  }

  async function handleRename(path: string): Promise<void> {
    const name = window.prompt("Rename to", path.split("/").at(-1));
    if (!name) return;
    await renameEntry(props.client, path, name);
    props.onTreeChanged();
  }

  async function handleDelete(path: string): Promise<void> {
    const didDelete = await confirmAndDelete(props.client, path, window.confirm.bind(window));
    if (didDelete) props.onTreeChanged();
  }

  async function handlePaste(targetDir: string): Promise<void> {
    if (!clipboard) return;
    await pasteEntry(props.client, clipboard, targetDir);
    setClipboard(null);
    props.onTreeChanged();
  }

  useImperativeHandle(ref, () => ({
    newFileInSelectedDir: () => {
      void handleCreate("file", containingDir(selected?.path ?? null, selected?.kind));
    },
    newFolderInSelectedDir: () => {
      void handleCreate("dir", containingDir(selected?.path ?? null, selected?.kind));
    },
    renameSelected: () => {
      if (selected) void handleRename(selected.path);
    },
    deleteSelected: () => {
      if (selected) void handleDelete(selected.path);
    },
    // selected/handleCreate/etc close over props.client and clipboard, so
    // they must be rebuilt whenever any of those change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [selected, props.client, clipboard]);

  return (
    <div
      ref={containerRef}
      style={{ height: "100%", width: "100%", background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)" }}
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
        }}
      >
        <Tree
          data={data}
          openByDefault={false}
          width={size.width}
          height={size.height}
          selection={props.activePath ?? undefined}
          onSelect={(nodes) => {
            const node = nodes[0];
            if (!node) return;
            setSelected({ path: node.data.id, kind: node.data.kind });
            if (node.data.kind === "file") props.onOpen(node.data.id);
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
          {menu.node.data.kind === "dir" && (
            <MenuItem onClick={() => { void handleCreate("file", menu.node.data.id); setMenu(null); }}>New File</MenuItem>
          )}
          {menu.node.data.kind === "dir" && (
            <MenuItem onClick={() => { void handleCreate("dir", menu.node.data.id); setMenu(null); }}>New Folder</MenuItem>
          )}
          <MenuItem onClick={() => { void handleRename(menu.node.data.id); setMenu(null); }}>Rename</MenuItem>
          <MenuItem onClick={() => { void handleDelete(menu.node.data.id); setMenu(null); }}>Delete</MenuItem>
          <MenuItem onClick={() => { setClipboard({ path: menu.node.data.id, mode: "cut" }); setMenu(null); }}>Cut</MenuItem>
          <MenuItem onClick={() => { setClipboard({ path: menu.node.data.id, mode: "copy" }); setMenu(null); }}>Copy</MenuItem>
          <MenuItem
            disabled={!clipboard}
            onClick={() => {
              if (!clipboard) return;
              void handlePaste(menu.node.data.kind === "dir" ? menu.node.data.id : containingDir(menu.node.data.id, "file"));
              setMenu(null);
            }}
          >
            Paste
          </MenuItem>
        </div>
      )}
    </div>
  );
});
