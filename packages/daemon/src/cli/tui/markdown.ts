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
