import { useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import type { RpcClient, TreeEntry, FsTreeResult } from "@zero/protocol";

interface Node {
  id: string;
  name: string;
  kind: "file" | "dir";
  children?: Node[];
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

const EXTENSION_ICONS: Record<string, string> = {
  ts: "\u{1F537}",
  tsx: "\u{1F535}",
  js: "\u{1F7E8}",
  jsx: "\u{1F7E7}",
  json: "\u{1F7E9}",
  md: "\u{1F4DD}",
  mdx: "\u{1F4DD}",
  css: "\u{1F3A8}",
  scss: "\u{1F3A8}",
  html: "\u{1F9E1}",
  png: "\u{1F5BC}",
  jpg: "\u{1F5BC}",
  jpeg: "\u{1F5BC}",
  gif: "\u{1F5BC}",
  svg: "\u{1F7E3}",
  py: "\u{1F40D}",
  rs: "\u{1F980}",
  go: "\u{1F53A}",
  sh: "\u{1F7E9}",
  bash: "\u{1F7E9}",
  yml: "\u{2699}\u{FE0F}",
  yaml: "\u{2699}\u{FE0F}",
  toml: "\u{2699}\u{FE0F}",
  lock: "\u{1F512}",
  env: "\u{1F511}",
  gitignore: "\u{1F648}",
  test: "\u{1F9EA}",
};

function iconFor(node: Node): string {
  if (node.kind === "dir") return "\u{1F4C1}";
  const ext = node.name.includes(".") ? node.name.split(".").at(-1)! : "";
  return EXTENSION_ICONS[ext] ?? "\u{1F4C4}";
}

function Row({ node, style, dragHandle }: NodeRendererProps<Node>) {
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
    >
      <span>{iconFor(node.data)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.data.name}</span>
    </div>
  );
}

export function FileTreePanel(props: {
  client: RpcClient;
  activePath: string | null;
  onOpen: (path: string) => void;
  refreshToken: number;
}) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 240, height: 500 });

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
      <Tree
        data={data}
        openByDefault={false}
        width={size.width}
        height={size.height}
        selection={props.activePath ?? undefined}
        onSelect={(nodes) => {
          const node = nodes[0];
          if (node && node.data.kind === "file") props.onOpen(node.data.id);
        }}
      >
        {Row}
      </Tree>
    </div>
  );
}
