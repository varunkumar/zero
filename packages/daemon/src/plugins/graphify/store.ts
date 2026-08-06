export interface GraphNode {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  source_location?: string;
  kind?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: string;
  confidence_score: number;
  source_file: string;
}

export interface GraphDocument {
  directed: boolean;
  multigraph: boolean;
  graph: Record<string, unknown>;
  nodes: GraphNode[];
  links: GraphEdge[];
}

export class GraphStore {
  #nodes = new Map<string, GraphNode>();
  #edges: GraphEdge[] = [];

  get nodeCount() {
    return this.#nodes.size;
  }

  get edgeCount() {
    return this.#edges.length;
  }

  clear(): void {
    this.#nodes.clear();
    this.#edges = [];
  }

  getNode(id: string): GraphNode | undefined {
    return this.#nodes.get(id);
  }

  nodes(): GraphNode[] {
    return [...this.#nodes.values()];
  }

  edges(): GraphEdge[] {
    return [...this.#edges];
  }

  addNodes(nodes: GraphNode[]): void {
    for (const n of nodes) this.#nodes.set(n.id, n);
  }

  addEdges(edges: GraphEdge[]): void {
    this.#edges.push(...edges);
  }

  removeFile(path: string): void {
    for (const [id, n] of this.#nodes) {
      if (n.source_file === path) this.#nodes.delete(id);
    }
    this.#edges = this.#edges.filter((e) => e.source_file !== path);
  }

  replaceFile(path: string, nodes: GraphNode[], edges: GraphEdge[]): void {
    this.removeFile(path);
    this.addNodes(nodes);
    this.addEdges(edges);
  }

  neighbors(id: string, depth = 1): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const seen = new Set<string>([id]);
    let frontier = new Set<string>([id]);
    const outEdges: GraphEdge[] = [];
    for (let d = 0; d < depth; d++) {
      const next = new Set<string>();
      for (const e of this.#edges) {
        if (frontier.has(e.source) || frontier.has(e.target)) {
          outEdges.push(e);
          if (!seen.has(e.source)) {
            seen.add(e.source);
            next.add(e.source);
          }
          if (!seen.has(e.target)) {
            seen.add(e.target);
            next.add(e.target);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...seen]
      .map((i) => this.#nodes.get(i))
      .filter(Boolean) as GraphNode[];
    return { nodes, edges: outEdges };
  }

  toJSON(): GraphDocument {
    return {
      directed: true,
      multigraph: false,
      graph: {},
      nodes: this.nodes(),
      links: this.edges(),
    };
  }

  loadJSON(doc: GraphDocument): void {
    this.clear();
    for (const n of doc.nodes ?? []) this.#nodes.set(n.id, n);
    this.#edges = [...(doc.links ?? [])];
  }
}
