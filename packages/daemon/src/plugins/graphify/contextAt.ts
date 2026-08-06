import type { GraphContextAtParams, GraphContextChunk } from "@zero/protocol";
import type { GraphStore, GraphNode } from "./store";

export function contextAt(
  store: GraphStore,
  params: GraphContextAtParams,
): GraphContextChunk[] {
  const max = params.maxChunks ?? 6;
  const line1 = params.position.line + 1; // source_location uses 1-based L{n}
  const inFile = store
    .nodes()
    .filter((n) => n.source_file === params.path && n.kind && n.kind !== "file");
  if (inFile.length === 0) {
    const fileNodes = store.nodes().filter((n) => n.source_file === params.path);
    return fileNodes.slice(0, max).map((n) => ({
      text: `file ${n.label}`,
      score: 0.4,
      source: `graph:${n.id}`,
    }));
  }

  const enclosing = pickEnclosing(inFile, line1) ?? inFile[0]!;
  const chunks: GraphContextChunk[] = [
    {
      text: formatSymbol(enclosing),
      score: 0.95,
      source: `graph:${enclosing.id}`,
    },
  ];

  const { edges } = store.neighbors(enclosing.id, 1);
  for (const e of edges) {
    if (e.relation === "calls" || e.relation === "imports") {
      const otherId = e.source === enclosing.id ? e.target : e.source;
      const other = store.getNode(otherId);
      if (!other) continue;
      chunks.push({
        text: `${e.relation} ${other.label}${other.source_file ? " @ " + other.source_file : ""}`,
        score: e.relation === "imports" ? 0.8 : 0.65,
        source: `graph:${other.id}`,
      });
    }
  }

  for (const n of inFile) {
    if (n.id === enclosing.id) continue;
    if (chunks.length >= max) break;
    chunks.push({
      text: formatSymbol(n),
      score: 0.45,
      source: `graph:${n.id}`,
    });
  }

  return chunks.sort((a, b) => b.score - a.score).slice(0, max);
}

function formatSymbol(n: GraphNode): string {
  return `${n.kind ?? "symbol"} ${n.label} @ ${n.source_file}${n.source_location ? ":" + n.source_location : ""}`;
}

function pickEnclosing(
  nodes: GraphNode[],
  line1: number,
): GraphNode | undefined {
  const withLine = nodes
    .map((n) => ({ n, line: parseLoc(n.source_location) }))
    .filter((x): x is { n: GraphNode; line: number } => x.line !== undefined && x.line <= line1);
  withLine.sort((a, b) => b.line - a.line);
  return withLine[0]?.n;
}

function parseLoc(loc?: string): number | undefined {
  if (!loc) return undefined;
  const m = /^L(\d+)/.exec(loc);
  return m ? Number(m[1]) : undefined;
}
