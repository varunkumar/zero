import { useMemo } from "react";
import { marked } from "marked";
import { highlightCode, highlightCodeHtml, highlightDiff, highlightDiffHtml } from "./codeHighlight";
import { sanitizeHtml } from "../sanitizeHtml";

export const CODE_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Renders inline `` `code` `` spans within a plain-text segment (already
 * known to contain no fenced code blocks - those are split out by
 * `renderMessageContent` before this runs). */
export function renderInlineCode(text: string, keyPrefix: string): React.ReactNode[] {
  const segments = text.split(/`([^`\n]+)`/g);
  return segments.map((seg, i) =>
    i % 2 === 1 ? (
      <code key={`${keyPrefix}-${i}`} style={{
        background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
        color: "var(--zero-editor-fg)", borderRadius: 3, padding: "1px 4px", fontFamily: CODE_FONT, fontSize: "0.9em",
      }}>
        {seg}
      </code>
    ) : (
      seg
    ),
  );
}

/** A fenced code block, syntax-highlighted when `lang` is recognized
 * (`highlightCode` returns null for anything it doesn't have a grammar
 * for), diff-colored for "diff"/"patch", or left as plain monospace text
 * otherwise - always themed and horizontally scrollable either way. */
export function CodeBlock(props: { lang: string; code: string }) {
  const body = props.code.replace(/\n$/, ""); // trailing newline before the closing ``` renders as a blank last line otherwise
  const isDiff = props.lang === "diff" || props.lang === "patch";
  const highlighted = isDiff ? null : highlightCode(body, props.lang);
  return (
    <pre style={{
      margin: "6px 0", padding: 8, borderRadius: 4, overflowX: "auto",
      background: "var(--zero-sidebar-bg)", border: "1px solid var(--zero-border)",
      color: "var(--zero-editor-fg)", fontFamily: CODE_FONT, fontSize: 12,
    }}>
      {isDiff ? <code>{highlightDiff(body)}</code> : <code>{highlighted ?? body}</code>}
    </pre>
  );
}

/** Renders a chat message body with fenced ```lang code blocks (syntax- or
 * diff-highlighted, see `CodeBlock`) and inline `code` spans styled as code
 * rather than as flat pre-wrap text - tool output and code snippets were
 * previously indistinguishable from prose. Used for plain-text messages and
 * as the streaming (still-arriving) render path. */
export function renderMessageContent(text: string): React.ReactNode {
  const parts = text.split(/```(\w*)\n([\s\S]*?)```/g);
  // With two capture groups, split() interleaves [text, lang, code, text,
  // lang, code, ..., text]: index%3===0 is surrounding prose, %3===1 is the
  // fence's language tag, %3===2 is the code body (consumed alongside its
  // language tag, so it's skipped when encountered on its own below).
  return parts.map((part, i) => {
    const mod = i % 3;
    if (mod === 2) return null;
    if (mod === 1) return <CodeBlock key={i} lang={part} code={parts[i + 1] ?? ""} />;
    if (!part) return null;
    return <span key={i} style={{ whiteSpace: "pre-wrap" }}>{renderInlineCode(part, String(i))}</span>;
  });
}

/** Small "T" badge preceding a tool-result row. */
export function ToolAvatar() {
  return (
    <span aria-hidden style={{
      width: 18, height: 18, borderRadius: "50%", display: "inline-flex",
      alignItems: "center", justifyContent: "center", fontSize: 11, flexShrink: 0,
      background: "var(--zero-status-ok)", color: "#fff",
    }}>
      T
    </span>
  );
}

export type MessageFormat = "json" | "xml" | "yaml" | "csv" | "html" | "markdown" | "plain";

function looksLikeJson(t: string): boolean {
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const parsed = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function looksLikeXml(t: string): boolean {
  if (/^<\?xml/i.test(t)) return true;
  return /^<([a-zA-Z][\w:.-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(t);
}

// Deliberately excludes generic element names ("body", "a", "p") that show
// up just as often in arbitrary XML documents - only tags that are
// distinctly HTML vocabulary count.
function looksLikeHtml(t: string): boolean {
  return /<!doctype html/i.test(t)
    || /<(html|head|div|span|table|ul|ol|li|h[1-6]|img|br|script|style)\b[^>]*>/i.test(t);
}

function looksLikeYaml(t: string): boolean {
  const lines = t.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;
  const structured = lines.filter((l) => /^[ \t]*[\w.-]+:\s?.*$/.test(l) || /^[ \t]*-\s/.test(l));
  return structured.length / lines.length > 0.6 && !/^#{1,6}\s/.test(lines[0]!);
}

function looksLikeCsv(t: string): boolean {
  const lines = t.split("\n").filter((l) => l.length > 0);
  if (lines.length < 2) return false;
  const counts = lines.map((l) => (l.match(/,/g) ?? []).length);
  return counts[0]! > 0 && counts.every((c) => c === counts[0]);
}

function looksLikeMarkdown(t: string): boolean {
  return /^#{1,6}\s/m.test(t)
    || /```/.test(t)
    || /\*\*[^*]+\*\*/.test(t)
    || /^[-*+]\s/m.test(t)
    || /^\d+\.\s/m.test(t)
    || /\[[^\]]+\]\([^)]+\)/.test(t)
    || /^\|.*\|$/m.test(t);
}

/** Heuristic content-type sniff for a final chat message body, since it's
 * just a string with no declared type. Order matters: HTML is checked
 * before the generic single-root-element XML check (real HTML like
 * `<div>...</div>` would otherwise match the XML shape too), and structural
 * formats are all checked before the much looser Markdown heuristic, which
 * would otherwise false-positive on e.g. a numbered YAML list. */
export function detectFormat(text: string): MessageFormat {
  const t = text.trim();
  if (!t) return "plain";
  if (looksLikeJson(t)) return "json";
  if (looksLikeHtml(t)) return "html";
  if (looksLikeXml(t)) return "xml";
  if (looksLikeYaml(t)) return "yaml";
  if (looksLikeCsv(t)) return "csv";
  if (looksLikeMarkdown(t)) return "markdown";
  return "plain";
}

const markedRenderer = new marked.Renderer();
markedRenderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
  const isDiff = language === "diff" || language === "patch";
  const highlighted = isDiff ? highlightDiffHtml(text) : highlightCodeHtml(text, language);
  const style = `margin:6px 0;padding:8px;border-radius:4px;overflow-x:auto;`
    + `background:var(--zero-sidebar-bg);border:1px solid var(--zero-border);`
    + `color:var(--zero-editor-fg);font-family:${CODE_FONT};font-size:12px`;
  return `<pre style="${style}"><code>${highlighted ?? text}</code></pre>`;
};

/** Markdown -> sanitized HTML, using `markedRenderer` so fenced code blocks
 * keep the same highlighting as `CodeBlock` (see `highlightCodeHtml`)
 * instead of marked's default unstyled `<pre><code>`. */
function renderChatMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, renderer: markedRenderer }) as string;
  return sanitizeHtml(html);
}

function SanitizedHtml(props: { content: string; toSafeHtml: (content: string) => string }) {
  const safe = useMemo(() => props.toSafeHtml(props.content), [props.content, props.toSafeHtml]);
  return <div className="zero-chat-markdown" dangerouslySetInnerHTML={{ __html: safe }} />;
}

function prettyPrintJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Renders a final chat message body per `detectFormat`: Markdown/HTML
 * through `marked` + DOMPurify (see the security note on `MarkdownPreview`
 * for why sanitization is load-bearing, not optional, here too - this is
 * the same untrusted-content-executes-in-the-workbench-origin risk),
 * JSON/XML/YAML/CSV pretty-printed into a `CodeBlock`, and plain text
 * through the existing fenced-code-aware `renderMessageContent`. */
export function renderFormattedMessage(text: string): React.ReactNode {
  const format = detectFormat(text);
  switch (format) {
    case "json":
      return <CodeBlock lang="json" code={prettyPrintJson(text)} />;
    case "xml":
      return <CodeBlock lang="xml" code={text} />;
    case "yaml":
      return <CodeBlock lang="yaml" code={text} />;
    case "csv":
      return <CodeBlock lang="csv" code={text} />;
    case "html":
      return <SanitizedHtml content={text} toSafeHtml={sanitizeHtml} />;
    case "markdown":
      return <SanitizedHtml content={text} toSafeHtml={renderChatMarkdown} />;
    default:
      return renderMessageContent(text);
  }
}
