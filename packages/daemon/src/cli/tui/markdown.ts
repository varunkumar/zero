// packages/daemon/src/cli/tui/markdown.ts
// Splits chat message text into plain-text and fenced-code-block segments,
// and estimates how many terminal rows each segment renders as - the same
// arithmetic the transcript layout budget (ChatScreen.tsx) needs to stay
// in sync with what Ink actually paints, or long/multi-line content can
// blow past the fixed-height transcript box again (see the header/footer
// corruption bug this replaces the naive length-based estimate for).

export interface TextBlock { kind: "text"; content: string }
export interface CodeBlock { kind: "code"; lang: string; lines: string[] }
export type Block = TextBlock | CodeBlock;

const FENCE_RE = /```(\S*)\n?([\s\S]*?)```/g;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(text))) {
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      if (before) blocks.push({ kind: "text", content: before });
    }
    const lang = match[1] ?? "";
    const body = (match[2] ?? "").replace(/\n$/, "");
    blocks.push({ kind: "code", lang, lines: body.length > 0 ? body.split("\n") : [""] });
    lastIndex = FENCE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    const rest = text.slice(lastIndex);
    if (rest) blocks.push({ kind: "text", content: rest });
  }
  return blocks.length > 0 ? blocks : [{ kind: "text", content: text }];
}

function rowsForPlainLine(line: string, columns: number): number {
  return Math.max(1, Math.ceil((line.length || 1) / Math.max(1, columns)));
}

export function estimateBlockRows(block: Block, columns: number): number {
  if (block.kind === "code") {
    // border top + border bottom + optional language label + one row per
    // source line (code lines render truncated, never wrapped).
    return block.lines.length + 2 + (block.lang ? 1 : 0);
  }
  return block.content.split("\n").reduce((sum, l) => sum + rowsForPlainLine(l, columns), 0);
}

export function estimateTextRows(text: string, columns: number): number {
  return parseBlocks(text).reduce((sum, b) => sum + estimateBlockRows(b, columns), 0);
}

export type MessageFormat = "json" | "xml" | "yaml" | "csv" | "html" | "markdown" | "plain";

// Mirrors the web chat panel's heuristic (packages/web/src/workbench/chat/
// messageFormatting.tsx) so a reply looks the same whether read in the
// browser or this terminal UI - see that file for the reasoning behind each
// check and the ordering between them.
function looksLikeJson(t: string): boolean {
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    const parsed: unknown = JSON.parse(t);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function looksLikeHtml(t: string): boolean {
  return /<!doctype html/i.test(t)
    || /<(html|head|div|span|table|ul|ol|li|h[1-6]|img|br|script|style)\b[^>]*>/i.test(t);
}

function looksLikeXml(t: string): boolean {
  if (/^<\?xml/i.test(t)) return true;
  return /^<([a-zA-Z][\w:.-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(t);
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

export function detectMessageFormat(text: string): MessageFormat {
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

function prettyPrintJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Wraps `text` in a fenced code block for the given structured format so it
 * renders through the existing `CodeBlockView` pipeline (border + line
 * highlighting) instead of as flat prose. */
function asFencedBlock(text: string, lang: string): string {
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

/** Prepares a final chat message body for the transcript per its detected
 * format: JSON/XML/YAML/CSV get fenced (JSON pretty-printed first) so they
 * render as a bordered, highlighted code block; Markdown/plain pass through
 * unchanged (Markdown gets lightweight heading/list treatment in
 * `TextBlockView`, driven by the caller passing `format` through); HTML
 * can't be rendered in a terminal, so it's left as plain text by design. */
export function prepareMessageForTranscript(text: string): { text: string; format: MessageFormat } {
  const format = detectMessageFormat(text);
  switch (format) {
    case "json":
      return { text: asFencedBlock(prettyPrintJson(text), "json"), format };
    case "xml":
      return { text: asFencedBlock(text, "xml"), format };
    case "yaml":
      return { text: asFencedBlock(text, "yaml"), format };
    case "csv":
      return { text: asFencedBlock(text, "csv"), format };
    default:
      return { text, format };
  }
}
