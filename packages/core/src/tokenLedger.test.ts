import { expect, test } from "bun:test";
import {
  capToolOutput, estimateMessagesTokens, needsCompaction, selectForCompaction,
  TOOL_OUTPUT_CHAR_CAP, KEEP_RECENT_EXCHANGES,
} from "./tokenLedger";
import type { ChatMessage } from "./chatTypes";

test("capToolOutput leaves short output untouched", () => {
  expect(capToolOutput("short")).toBe("short");
});

test("capToolOutput truncates and marks long output", () => {
  const long = "x".repeat(TOOL_OUTPUT_CHAR_CAP + 500);
  const capped = capToolOutput(long);
  expect(capped.length).toBe(TOOL_OUTPUT_CHAR_CAP + "\n...[truncated]".length);
  expect(capped.startsWith("x".repeat(TOOL_OUTPUT_CHAR_CAP))).toBe(true);
  expect(capped.endsWith("...[truncated]")).toBe(true);
});

function msg(content: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return { role, content, createdAt: 0 };
}

test("estimateMessagesTokens sums per-message estimates (chars/4, rounded up)", () => {
  expect(estimateMessagesTokens([msg("abcd"), msg("abcdefgh")])).toBe(1 + 2);
});

test("needsCompaction is false comfortably under the 90% threshold", () => {
  const history = [msg("a".repeat(40))]; // 10 tokens
  expect(needsCompaction(history, 1000)).toBe(false);
});

test("needsCompaction is true once usage exceeds 90% of the budget", () => {
  const history = [msg("a".repeat(4000))]; // 1000 tokens
  expect(needsCompaction(history, 1000)).toBe(true); // 1000 > 900
  expect(needsCompaction(history, 2000)).toBe(false); // 1000 <= 1800
});

test("selectForCompaction keeps everything when there aren't more than keepRecent exchanges", () => {
  const history = [msg("hi", "user"), msg("hello", "assistant")];
  expect(selectForCompaction(history)).toEqual({ toSummarize: [], toKeep: history });
});

test("selectForCompaction splits at the boundary keeping the last N user-started exchanges", () => {
  // 6 user messages; default keepRecent is 4, so the split falls right before the 3rd-from-last user message.
  const history: ChatMessage[] = [];
  for (let i = 0; i < 6; i++) {
    history.push(msg(`q${i}`, "user"));
    history.push(msg(`a${i}`, "assistant"));
  }
  const { toSummarize, toKeep } = selectForCompaction(history);
  expect(toSummarize).toEqual(history.slice(0, 4)); // q0,a0,q1,a1
  expect(toKeep).toEqual(history.slice(4)); // q2..a5
  expect(toKeep.length).toBe(KEEP_RECENT_EXCHANGES * 2);
});

test("selectForCompaction with a custom keepRecent", () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 3; i++) { history.push(msg(`q${i}`, "user")); history.push(msg(`a${i}`, "assistant")); }
  const { toSummarize, toKeep } = selectForCompaction(history, 1);
  expect(toSummarize).toEqual(history.slice(0, 4));
  expect(toKeep).toEqual(history.slice(4));
});
