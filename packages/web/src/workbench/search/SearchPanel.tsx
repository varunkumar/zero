import { useEffect, useRef, useState } from "react";
import type { RpcClient, FsSearchResult, FsSearchMatch } from "@zero/protocol";
import { iconFor } from "../icons/iconFor";

/** A 1-character query matches nearly every file in a real repo, so it burns a
 * full-workspace scan to return a truncated, useless result set. */
const MIN_QUERY_LENGTH = 2;

/** Line text can run to hundreds of columns (minified JSON, long literals);
 * cap the rendered snippet so one result can't blow out the row height. */
const SNIPPET_MAX_LENGTH = 120;

function snippet(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > SNIPPET_MAX_LENGTH ? `${trimmed.slice(0, SNIPPET_MAX_LENGTH)}…` : trimmed;
}

export function SearchPanel(props: { client: RpcClient; onJumpTo: (path: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FsSearchMatch[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const latestQueryRef = useRef(query);
  latestQueryRef.current = query; // updated synchronously on every render, no effect needed

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (query.length < MIN_QUERY_LENGTH) { setMatches([]); setTruncated(false); setError(null); return; }

    debounceRef.current = setTimeout(() => {
      props.client
        .request<FsSearchResult>("fs/search", { query })
        .then((res) => {
          // Only apply results if no newer query has been typed since this request was issued
          if (latestQueryRef.current === query) {
            setMatches(res.matches);
            setTruncated(res.truncated);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (latestQueryRef.current !== query) return;
          setMatches([]);
          setTruncated(false);
          setError(e instanceof Error ? e.message : String(e));
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
      {error && <div role="alert" style={{ padding: "0 8px", fontSize: 13, color: "var(--zero-error-fg, crimson)" }}>Search failed: {error}</div>}
      {truncated && <div style={{ padding: "0 8px", fontSize: 13, opacity: 0.7 }}>Showing first {matches.length} matches</div>}
      <div style={{ overflow: "auto", flex: 1 }}>
        {[...grouped.entries()].map(([path, fileMatches]) => (
          <div key={path} style={{ padding: "4px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, fontSize: 14 }}>
              <img src={iconFor(path.split("/").at(-1) ?? "", false)} alt="" width={14} height={14} style={{ flexShrink: 0 }} />
              {path}
            </div>
            {fileMatches.map((m, i) => (
              <div
                key={i}
                onClick={() => props.onJumpTo(m.path, m.line)}
                style={{ paddingLeft: 20, cursor: "pointer", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {m.line}: {snippet(m.text)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
