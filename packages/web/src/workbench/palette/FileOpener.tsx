import { useEffect, useMemo, useState } from "react";
import commandScore from "command-score";
import { Palette } from "./Palette";

/** A workspace can hold tens of thousands of files; every item rendered here
 * is a mounted `<Command.Item>` that cmdk re-scores on each keystroke. Rank
 * with `command-score` ourselves and mount only the best handful. */
const MAX_RESULTS = 200;

export function rankPaths(paths: string[], query: string, limit = MAX_RESULTS): string[] {
  const trimmed = query.trim();
  if (!trimmed) return paths.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const score = commandScore(path, trimmed);
    if (score > 0) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

export function FileOpener(props: { paths: string[]; open: boolean; onClose: () => void; onOpen: (path: string) => void }) {
  const [query, setQuery] = useState("");

  // FileOpener stays mounted across opens (Palette is what unmounts), so the
  // query has to be reset explicitly or the next Cmd+P reopens pre-filtered
  // against a stale query the (fresh, empty) input no longer shows.
  useEffect(() => {
    if (props.open) setQuery("");
  }, [props.open]);

  const items = useMemo(() => rankPaths(props.paths, query), [props.paths, query]);

  return (
    <Palette
      open={props.open}
      onClose={props.onClose}
      items={items}
      getLabel={(p) => p}
      onSelect={props.onOpen}
      placeholder="Go to file…"
      onQueryChange={setQuery}
      filter={false}
    />
  );
}
