const MAX_CELLS = 400_000;

/** Minimal LCS-based line diff. No context collapsing — output is a
 * one-shot approval preview, not meant for scrolling through a large file. */
export function diffPreview(oldText: string, newText: string): string {
  const oldLines = oldText.length ? oldText.split("\n") : [];
  const newLines = newText.length ? newText.split("\n") : [];
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > MAX_CELLS) {
    return `[diff too large to render in full: ${m} -> ${n} lines]`;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: string[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) { out.push(" " + oldLines[i]); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push("-" + oldLines[i]); i++; }
    else { out.push("+" + newLines[j]); j++; }
  }
  while (i < m) { out.push("-" + oldLines[i]); i++; }
  while (j < n) { out.push("+" + newLines[j]); j++; }
  return out.join("\n");
}
