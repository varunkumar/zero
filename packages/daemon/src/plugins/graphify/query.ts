import type { GraphQueryParams, GraphQueryResult } from "@zero/protocol";
import type { GraphStore } from "./store";

export function queryGraph(
  store: GraphStore,
  params: GraphQueryParams,
): GraphQueryResult {
  const q = params.q.trim().toLowerCase();
  const mode = params.mode ?? "neighbors";
  const budget = params.budgetTokens ?? 800;

  if (mode === "path") {
    const nodes = store
      .nodes()
      .filter((n) => n.source_file.toLowerCase().includes(q));
    const text = nodes
      .map((n) => `${n.kind ?? "node"} ${n.label} @ ${n.source_file}`)
      .join("\n");
    return {
      nodes: nodes.map(publicNode),
      edges: [],
      text: trimBudget(text, budget),
    };
  }

  const matches = store.nodes().filter(
    (n) =>
      n.label.toLowerCase() === q ||
      n.label.toLowerCase().includes(q) ||
      n.id.includes(q.replace(/\W+/g, "_")),
  );
  if (matches.length === 0) {
    return { nodes: [], edges: [], text: `No graph match for ${params.q}` };
  }

  if (mode === "symbol") {
    const text = matches
      .map(
        (n) =>
          `${n.kind ?? "symbol"} ${n.label} @ ${n.source_file}${n.source_location ? ":" + n.source_location : ""}`,
      )
      .join("\n");
    return {
      nodes: matches.map(publicNode),
      edges: [],
      text: trimBudget(text, budget),
    };
  }

  // neighbors of best match (exact label first)
  matches.sort((a, b) => scoreMatch(b, q) - scoreMatch(a, q));
  const best = matches[0]!;
  const { nodes, edges } = store.neighbors(best.id, 1);
  const lines = [
    `Symbol ${best.label} (${best.kind ?? "node"}) @ ${best.source_file}`,
    ...edges.map((e) => `${e.source} -[${e.relation}]-> ${e.target}`),
  ];
  return {
    nodes: nodes.map(publicNode),
    edges: edges.map((e) => ({
      source: e.source,
      target: e.target,
      relation: e.relation,
    })),
    text: trimBudget(lines.join("\n"), budget),
  };
}

function publicNode(n: {
  id: string;
  label: string;
  source_file?: string;
  kind?: string;
}) {
  return {
    id: n.id,
    label: n.label,
    source_file: n.source_file,
    kind: n.kind,
  };
}

function scoreMatch(n: { label: string; id: string }, q: string): number {
  const l = n.label.toLowerCase();
  if (l === q) return 3;
  if (l.startsWith(q)) return 2;
  if (l.includes(q)) return 1;
  return 0;
}

function trimBudget(text: string, budgetTokens: number): string {
  const maxChars = budgetTokens * 4;
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
