import { estimateTokens } from "./tokens";
import type { ChatMessage } from "./chatTypes";

export const TOOL_OUTPUT_CHAR_CAP = 4000;
export const COMPACTION_THRESHOLD_RATIO = 0.9;
export const KEEP_RECENT_EXCHANGES = 4;

export const COMPACTION_SYSTEM_PROMPT = `Summarize the conversation so far for the assistant's own future reference.
Use exactly these Markdown headings, omitting any with nothing to report:
## Goal
## Constraints
## Done
## In Progress
## Key Decisions
## Relevant Files
## Next Steps
Preserve exact file paths, commands, error strings, and identifiers. Omit
pleasantries and anything not needed to resume the task.`;

export function capToolOutput(text: string): string {
  return text.length <= TOOL_OUTPUT_CHAR_CAP ? text : text.slice(0, TOOL_OUTPUT_CHAR_CAP) + "\n...[truncated]";
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
}

export function needsCompaction(history: ChatMessage[], contextWindowTokens: number): boolean {
  return estimateMessagesTokens(history) > contextWindowTokens * COMPACTION_THRESHOLD_RATIO;
}

export function selectForCompaction(
  history: ChatMessage[],
  keepRecent = KEEP_RECENT_EXCHANGES,
): { toSummarize: ChatMessage[]; toKeep: ChatMessage[] } {
  const userIndexes: number[] = [];
  history.forEach((m, i) => { if (m.role === "user") userIndexes.push(i); });
  if (userIndexes.length <= keepRecent) return { toSummarize: [], toKeep: history };
  const splitAt = userIndexes[userIndexes.length - keepRecent]!;
  return { toSummarize: history.slice(0, splitAt), toKeep: history.slice(splitAt) };
}
