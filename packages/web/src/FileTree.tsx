import { useEffect, useState } from "react";
import type { RpcClient, TreeEntry, FsTreeResult } from "@zero/protocol";

export function FileTree(props: { client: RpcClient; onOpen: (path: string) => void; activePath: string | null }) {
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    props.client
      .request<FsTreeResult>("fs/tree")
      .then((res) => { if (!cancelled) setEntries(res.entries); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [props.client]);

  if (error) return <div style={{ padding: 8, color: "crimson" }}>{error}</div>;

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 8, overflow: "auto", height: "100%" }}>
      {entries.map((entry) => {
        const depth = entry.path.split("/").length - 1;
        const isActive = entry.path === props.activePath;
        return (
          <li
            key={entry.path}
            style={{
              paddingLeft: depth * 14,
              cursor: entry.kind === "file" ? "pointer" : "default",
              fontWeight: entry.kind === "dir" ? 600 : 400,
              background: isActive ? "#e0e7ff" : undefined,
              whiteSpace: "nowrap",
            }}
            onClick={() => { if (entry.kind === "file") props.onOpen(entry.path); }}
          >
            {entry.kind === "dir" ? "\u{1F4C1} " : "\u{1F4C4} "}
            {entry.path.split("/").at(-1)}
          </li>
        );
      })}
    </ul>
  );
}
