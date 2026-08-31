import { highlightTree, tagHighlighter, tags as t } from "@lezer/highlight";
import type { Highlighter } from "@lezer/highlight";
import { StreamLanguage, type Language } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { go } from "@codemirror/legacy-modes/mode/go";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { c, cpp, java, csharp } from "@codemirror/legacy-modes/mode/clike";

// One Language per grammar, built once at module load - languages are
// stateless parsers, safe to share across every code block on the page.
const jsLanguage = javascript({ typescript: true, jsx: true }).language;
const jsonLanguage = json().language;
const streamLang = <S,>(parser: import("@codemirror/language").StreamParser<S>): Language => StreamLanguage.define(parser);

/** Maps a fenced-code-block language tag (as written after the opening
 * ```, e.g. "ts", "py", "rs") to a CodeMirror `Language` to parse it with.
 * Absent/unrecognized tags fall back to plain, unhighlighted monospace text
 * in `codeToNodes` below - better an honest plain block than a wrong guess. */
const LANGUAGES: Record<string, Language> = {
  js: jsLanguage, jsx: jsLanguage, mjs: jsLanguage, cjs: jsLanguage,
  ts: jsLanguage, tsx: jsLanguage,
  json: jsonLanguage, jsonc: jsonLanguage,
  py: streamLang(python), python: streamLang(python),
  rs: streamLang(rust), rust: streamLang(rust),
  go: streamLang(go), golang: streamLang(go),
  sh: streamLang(shell), bash: streamLang(shell), shell: streamLang(shell), zsh: streamLang(shell),
  yaml: streamLang(yaml), yml: streamLang(yaml),
  toml: streamLang(toml),
  rb: streamLang(ruby), ruby: streamLang(ruby),
  sql: streamLang(standardSQL),
  c: streamLang(c),
  cpp: streamLang(cpp), "c++": streamLang(cpp),
  java: streamLang(java),
  cs: streamLang(csharp), csharp: streamLang(csharp),
};

// Mirrors the tag groupings in ../theme/syntaxHighlighting.ts, but emits CSS
// classes (styled in theme.css, themed via the same --zero-* custom
// properties) instead of that file's inline HighlightStyle colors - this
// runs outside a live CodeMirror EditorView, so there's no EditorView to
// auto-mount a HighlightStyle's generated stylesheet into.
const highlighter: Highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.bool, t.null, t.atom, t.self], class: "zero-tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp], class: "zero-tok-string" },
  { tag: [t.comment, t.lineComment, t.blockComment], class: "zero-tok-comment" },
  { tag: [t.number, t.integer, t.float], class: "zero-tok-number" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "zero-tok-function" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], class: "zero-tok-definition" },
  { tag: [t.variableName, t.constant(t.variableName)], class: "zero-tok-variable" },
  { tag: [t.typeName, t.className, t.standard(t.tagName), t.namespace], class: "zero-tok-type" },
  { tag: [t.propertyName, t.attributeName], class: "zero-tok-property" },
  { tag: t.tagName, class: "zero-tok-keyword" },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], class: "zero-tok-punctuation" },
  { tag: t.invalid, class: "zero-tok-invalid" },
]);

/** Tokenizes `code` under `lang` into React nodes with per-token `<span
 * className="zero-tok-*">` wrapping, or returns `null` if `lang` isn't
 * recognized (caller should render plain text instead). Parse failures on
 * malformed/partial code (e.g. still-streaming output) degrade to the
 * unhighlighted original text rather than throwing. */
export function highlightCode(code: string, lang: string): React.ReactNode[] | null {
  const language = LANGUAGES[lang.toLowerCase()];
  if (!language) return null;
  try {
    const tree = language.parser.parse(code);
    const nodes: React.ReactNode[] = [];
    let pos = 0;
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > pos) nodes.push(code.slice(pos, from));
      nodes.push(<span key={from} className={classes}>{code.slice(from, to)}</span>);
      pos = to;
    });
    if (pos < code.length) nodes.push(code.slice(pos));
    return nodes;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch] as string
  ));
}

/** Same tokenization as `highlightCode`, but emitting an HTML string (`<span
 * class="zero-tok-*">`) instead of React nodes - for content that has to
 * pass through `dangerouslySetInnerHTML` (e.g. a marked-rendered Markdown
 * message), where code fences still need to match `CodeBlock`'s coloring. */
export function highlightCodeHtml(code: string, lang: string): string | null {
  const language = LANGUAGES[lang.toLowerCase()];
  if (!language) return null;
  try {
    const tree = language.parser.parse(code);
    let html = "";
    let pos = 0;
    highlightTree(tree, highlighter, (from, to, classes) => {
      if (from > pos) html += escapeHtml(code.slice(pos, from));
      html += `<span class="${classes}">${escapeHtml(code.slice(from, to))}</span>`;
      pos = to;
    });
    if (pos < code.length) html += escapeHtml(code.slice(pos));
    return html;
  } catch {
    return null;
  }
}

/** HTML-string counterpart to `highlightDiff`, for the same reason as
 * `highlightCodeHtml`. */
export function highlightDiffHtml(text: string): string {
  return text.split("\n").map((line) => {
    let className = "zero-diff-context";
    if (line.startsWith("+++") || line.startsWith("---")) className = "zero-diff-file";
    else if (line.startsWith("@@")) className = "zero-diff-hunk";
    else if (line.startsWith("+")) className = "zero-diff-add";
    else if (line.startsWith("-")) className = "zero-diff-del";
    return `<div class="${className}" style="white-space:pre">${escapeHtml(line.length ? line : " ")}</div>`;
  }).join("");
}

/** Line-based coloring for unified-diff/patch text: +/- lines and hunk
 * headers get a background tint, matching the GitHub-style diff convention
 * users actually expect - a token grammar isn't the right tool here, diffs
 * are colored per *line*, not per syntax token. */
export function highlightDiff(text: string): React.ReactNode[] {
  return text.split("\n").map((line, i) => {
    let className = "zero-diff-context";
    if (line.startsWith("+++") || line.startsWith("---")) className = "zero-diff-file";
    else if (line.startsWith("@@")) className = "zero-diff-hunk";
    else if (line.startsWith("+")) className = "zero-diff-add";
    else if (line.startsWith("-")) className = "zero-diff-del";
    return (
      <div key={i} className={className} style={{ whiteSpace: "pre" }}>
        {line.length ? line : " "}
      </div>
    );
  });
}
