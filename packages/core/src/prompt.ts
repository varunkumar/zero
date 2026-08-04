import type { CompletionRequest, ContextChunk, ModelCapabilities } from "./types";
import { estimateTokens } from "./tokens";

export function buildFimPrompt(
  req: CompletionRequest,
  chunks: ContextChunk[],
  caps: ModelCapabilities
): string {
  const budget = Math.max(0, caps.contextWindowTokens - 256);
  const body = caps.supportsFim
    ? (p: string, s: string) =>
        `<|fim_prefix|>${p}<|fim_suffix|>${s}<|fim_middle|>`
    : (p: string, s: string) =>
        `Continue the code at <CURSOR>. Output only code.\n${p}<CURSOR>${s}`;

  // Reserve up to half the budget for context, rest for prefix/suffix.
  const picked: string[] = [];
  let used = 0;
  const contextBudget = Math.floor(budget / 2);
  for (const c of [...chunks].sort((a, b) => b.score - a.score)) {
    if (used + c.tokenCost > contextBudget) continue;
    picked.push(c.text);
    used += c.tokenCost;
  }

  let { prefix, suffix } = req;
  const fit = () => estimateTokens(body(prefix, suffix)) + used <= budget;
  while (!fit() && (prefix.length > 0 || suffix.length > 0)) {
    if (prefix.length >= suffix.length) prefix = prefix.slice(100); // trim far-from-cursor left edge
    else suffix = suffix.slice(0, -100); // trim far-from-cursor right edge
  }
  const context = picked.length ? picked.join("\n") + "\n" : "";
  return context + body(prefix, suffix);
}
