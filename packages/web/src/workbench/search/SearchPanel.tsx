import { useEffect, useRef, useState } from "react";
import type { RpcClient, FsSearchResult, FsSearchMatch } from "@zero/protocol";

export function SearchPanel(props: { client: RpcClient; onJumpTo: (path: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FsSearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query) { setMatches([]); setTruncated(false); return; }
    debounceRef.current = setTimeout(() => {
      props.client.request<FsSearchResult>("fs/search", { query }).then((res) => {
        setMatches(res.matches);
        setTruncated(res.truncated);
      });
    }, 200);
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, props.client]);

  const grouped = new Map<string, FsSearchMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.path) ?? [];
    list.push(match);
    grouped.set(match.path, list);
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--zero-sidebar-bg)", color: "var(--zero-sidebar-fg)" }}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search across files…"
        style={{ margin: 8, padding: 6, background: "var(--zero-editor-bg)", color: "var(--zero-editor-fg)", border: "1px solid var(--zero-border)" }}
      />
      {truncated && <div style={{ padding: "0 8px", fontSize: 11, opacity: 0.7 }}>Showing first {matches.length} matches</div>}
      <div style={{ overflow: "auto", flex: 1 }}>
        {[...grouped.entries()].map(([path, fileMatches]) => (
          <div key={path} style={{ padding: "4px 8px" }}>
            <div style={{ fontWeight: 600, fontSize: 12 }}>{path}</div>
            {fileMatches.map((m, i) => (
              <div
                key={i}
                onClick={() => props.onJumpTo(m.path, m.line)}
                style={{ paddingLeft: 12, cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {m.line}: {m.text.trim()}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
