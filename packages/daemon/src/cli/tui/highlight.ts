// packages/daemon/src/cli/tui/highlight.ts
// A deliberately small, language-agnostic token colorer for code blocks in
// the transcript - not a real per-language grammar. It recognizes the
// handful of token shapes (comments, strings, numbers, a shared keyword
// set) that read as "syntax highlighted" at a glance across the common
// languages users paste (JS/TS, Python, shell, Rust, Go) without pulling
// in a full highlighting engine for a CLI chat transcript.

export interface Token { text: string; color?: string; dim?: boolean }

const KEYWORDS = new Set([
  "function", "const", "let", "var", "if", "else", "for", "while", "return",
  "import", "export", "from", "class", "extends", "new", "this", "async",
  "await", "try", "catch", "finally", "throw", "switch", "case", "break",
  "continue", "default", "typeof", "instanceof", "in", "of", "null",
  "undefined", "void", "yield", "interface", "type", "enum", "implements",
  "public", "private", "protected", "static", "readonly", "def", "elif",
  "except", "pass", "lambda", "with", "as", "None", "True", "False", "self",
  "fn", "mut", "impl", "pub", "struct", "match", "use", "package", "func",
  "go", "chan", "select", "defer", "echo", "then", "fi", "do", "done",
]);

const TOKEN_RE = /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)/gm;

export function highlightLine(line: string): Token[] {
  const tokens: Token[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line))) {
    if (match.index > lastIndex) tokens.push({ text: line.slice(lastIndex, match.index), dim: true });
    const [, comment, str, num, word, ws] = match;
    if (comment) tokens.push({ text: comment, dim: true });
    else if (str) tokens.push({ text: str, color: "green" });
    else if (num) tokens.push({ text: num, color: "yellow" });
    else if (word) tokens.push({ text: word, color: KEYWORDS.has(word) ? "magenta" : undefined });
    else if (ws) tokens.push({ text: ws });
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex), dim: true });
  return tokens.length > 0 ? tokens : [{ text: line || " " }];
}
