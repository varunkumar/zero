import { Parser, type Node } from "web-tree-sitter";
import type { GraphEdge, GraphNode } from "./store";
import { loadLanguage, type GrammarSettings } from "./grammars";

export function nodeId(path: string, entity: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const file = parts.pop() ?? path;
  const parent = parts.pop() ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  const base = [parent, stem].filter(Boolean).join("_");
  return `${base}_${entity}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_");
}

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_expression",
  "arrow_function",
]);

const CLASS_TYPES = new Set(["class_declaration", "class"]);

function extractName(node: Node): string | undefined {
  const nameNode = node.childForFieldName("name");
  if (nameNode?.text) return nameNode.text;
  // variable_declarator with arrow/function_expression: name is on parent
  return undefined;
}

export async function extractFromSource(
  path: string,
  source: string,
  languageId: string,
  overrides?: GrammarSettings,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const lang = await loadLanguage(languageId, overrides);
  if (!lang) return { nodes: [], edges: [] };

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) {
    parser.delete();
    return { nodes: [], edges: [] };
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const fileId = nodeId(path, "file");
  nodes.push({
    id: fileId,
    label: path.split("/").pop() ?? path,
    file_type: "code",
    source_file: path,
    kind: "file",
  });

  const symbols = new Map<string, string>(); // name -> id
  const symbolRanges: { name: string; id: string; start: number; end: number }[] =
    [];

  const walk = (node: Node) => {
    // function / class / method with a name field
    if (FUNCTION_TYPES.has(node.type) || CLASS_TYPES.has(node.type)) {
      let name = extractName(node);
      // Named function_expression assigned to a variable: climb to variable_declarator
      if (!name && (node.type === "function_expression" || node.type === "arrow_function")) {
        const parent = node.parent;
        if (parent?.type === "variable_declarator") {
          name = parent.childForFieldName("name")?.text;
        } else if (
          parent?.type === "assignment_expression" &&
          parent.childForFieldName("left")?.type === "identifier"
        ) {
          name = parent.childForFieldName("left")?.text;
        }
      }
      if (name) {
        const kind = CLASS_TYPES.has(node.type)
          ? "class"
          : node.type === "method_definition"
            ? "method"
            : "function";
        const id = nodeId(path, name);
        if (!symbols.has(name)) {
          const loc = `L${node.startPosition.row + 1}`;
          nodes.push({
            id,
            label: name,
            file_type: "code",
            source_file: path,
            source_location: loc,
            kind,
          });
          edges.push({
            source: fileId,
            target: id,
            relation: "contains",
            confidence: "EXTRACTED",
            confidence_score: 1,
            source_file: path,
          });
          symbols.set(name, id);
          symbolRanges.push({
            name,
            id,
            start: node.startIndex,
            end: node.endIndex,
          });
        }
      }
    }

    // lexical const/let/var with function initializer
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name")?.text;
      const value = node.childForFieldName("value");
      if (
        name &&
        value &&
        (value.type === "arrow_function" ||
          value.type === "function_expression" ||
          value.type === "generator_function")
      ) {
        if (!symbols.has(name)) {
          const id = nodeId(path, name);
          const loc = `L${node.startPosition.row + 1}`;
          nodes.push({
            id,
            label: name,
            file_type: "code",
            source_file: path,
            source_location: loc,
            kind: "function",
          });
          edges.push({
            source: fileId,
            target: id,
            relation: "contains",
            confidence: "EXTRACTED",
            confidence_score: 1,
            source_file: path,
          });
          symbols.set(name, id);
          symbolRanges.push({
            name,
            id,
            start: node.startIndex,
            end: node.endIndex,
          });
        }
      }
    }

    for (const c of node.children) walk(c);
  };
  walk(tree.rootNode);

  // import_statement → imports edges (module node)
  const collectImports = (node: Node) => {
    if (node.type === "import_statement") {
      const sourceNode = node.childForFieldName("source");
      // grammar uses field "source" on import_statement for the string
      let spec: string | undefined;
      if (sourceNode) {
        spec = sourceNode.text.replace(/^['"]|['"]$/g, "");
      } else {
        // fallback: last string child
        for (const c of node.children) {
          if (c.type === "string") {
            spec = c.text.replace(/^['"]|['"]$/g, "");
          }
        }
      }
      if (spec) {
        const modId = nodeId(path, `mod_${spec}`);
        if (!nodes.some((n) => n.id === modId)) {
          nodes.push({
            id: modId,
            label: spec,
            file_type: "code",
            source_file: path,
            kind: "module",
          });
        }
        edges.push({
          source: fileId,
          target: modId,
          relation: "imports",
          confidence: "EXTRACTED",
          confidence_score: 1,
          source_file: path,
        });
      }
    }
    for (const c of node.children) collectImports(c);
  };
  collectImports(tree.rootNode);

  // Best-effort call edges: call_expression whose function is a local symbol
  const seenCalls = new Set<string>();
  const collectCalls = (node: Node) => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier") {
        const callee = fn.text;
        const targetId = symbols.get(callee);
        if (targetId) {
          // caller = innermost enclosing symbol range
          let callerId: string | undefined;
          for (const r of symbolRanges) {
            if (
              node.startIndex >= r.start &&
              node.endIndex <= r.end &&
              r.id !== targetId
            ) {
              if (!callerId) callerId = r.id;
              // prefer tightest range (later in walk ≈ nested); keep last matching
              callerId = r.id;
            }
          }
          // if still none, try first symbol that isn't the callee (legacy heuristic)
          if (!callerId) {
            for (const [name, id] of symbols) {
              if (id !== targetId) {
                callerId = id;
                break;
              }
            }
          }
          if (callerId) {
            const key = `${callerId}->${targetId}`;
            if (!seenCalls.has(key)) {
              seenCalls.add(key);
              edges.push({
                source: callerId,
                target: targetId,
                relation: "calls",
                confidence: "EXTRACTED",
                confidence_score: 1,
                source_file: path,
              });
            }
          }
        }
      }
    }
    for (const c of node.children) collectCalls(c);
  };
  collectCalls(tree.rootNode);

  tree.delete();
  parser.delete();
  return { nodes, edges };
}
