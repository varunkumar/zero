import React, { useCallback, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { bannerLines } from "./Banner";

export interface ChatScreenProps {
  runtime: Pick<AgentRuntime, "sendMessage" | "resolveApproval">;
  sessionId: string;
  initialLines: string[];
  cwd: string;
  /** Called once, on the first message submitted in this component
   * instance, with that message's text. Used by the caller to give a
   * freshly-created (or empty resumed) session a meaningful title instead
   * of the generic default. */
  onFirstMessage?: (text: string) => void;
}

interface PendingApproval { call: ChatToolCall; preview: string }
interface Line { id: string; text: string; bold?: boolean; dim?: boolean; color?: string }

let lineSeq = 0;
function nextLineId(): string { return `line-${++lineSeq}`; }

export function ChatScreen({ runtime, sessionId, initialLines, cwd, onFirstMessage }: ChatScreenProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => [
    ...bannerLines(cwd, "/exit to quit · esc cancels a turn").map((l) => ({ id: nextLineId(), ...l })),
    ...initialLines.map((text) => ({ id: nextLineId(), text })),
  ]);
  const [streamingText, setStreamingText] = useState("");
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const controllerRef = useRef<AbortController | null>(null);
  const hasSentRef = useRef(false);

  const pushLine = useCallback((text: string) => {
    setLines((prev) => [...prev, { id: nextLineId(), text }]);
  }, []);

  const runTurn = useCallback(async (userText: string) => {
    if (!hasSentRef.current) {
      hasSentRef.current = true;
      onFirstMessage?.(userText);
    }
    setBusy(true);
    pushLine(`> ${userText}`);
    const controller = new AbortController();
    controllerRef.current = controller;
    let assistantText = "";
    try {
      for await (const event of runtime.sendMessage(sessionId, userText, controller.signal)) {
        if (event.type === "text") {
          assistantText += event.delta;
          setStreamingText(assistantText);
        } else if (event.type === "toolCall") {
          pushLine(`[tool] ${event.call.name} ${JSON.stringify(event.call.args)}`);
        } else if (event.type === "approvalRequest") {
          setPending({ call: event.call, preview: event.preview });
        } else if (event.type === "toolResult") {
          pushLine(`[result] ${event.result}`);
        } else if (event.type === "error") {
          pushLine(`[error] ${event.message}`);
        } else if (event.type === "done") {
          if (assistantText) pushLine(assistantText);
        }
      }
    } finally {
      setStreamingText("");
      setBusy(false);
      controllerRef.current = null;
    }
  }, [runtime, sessionId, pushLine, onFirstMessage]);

  const onResolveApproval = useCallback((approved: boolean) => {
    if (!pending) return;
    runtime.resolveApproval(pending.call.id, approved);
    setPending(null);
  }, [pending, runtime]);

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    setInput("");
    if (!trimmed || busy) return;
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    void runTurn(trimmed);
  }, [busy, runTurn, exit]);

  useInput((_input, key) => {
    if (key.escape && !pending) exit();
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => (
          <Text key={line.id} color={line.color} bold={line.bold} dimColor={line.dim}>
            {line.text}
          </Text>
        )}
      </Static>
      {streamingText ? <Text>{streamingText}</Text> : null}
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="green">{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} focus={!busy} />
          </Box>
          <Text dimColor>{busy ? "working..." : "/exit to quit"}</Text>
        </Box>
      )}
    </Box>
  );
}
