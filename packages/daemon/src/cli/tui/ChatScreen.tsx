import React, { useCallback, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";

export interface ChatScreenProps {
  runtime: Pick<AgentRuntime, "sendMessage" | "resolveApproval">;
  sessionId: string;
  initialLines: string[];
}

interface PendingApproval { call: ChatToolCall; preview: string }
interface Line { id: string; text: string }

let lineSeq = 0;
function nextLineId(): string { return `line-${++lineSeq}`; }

export function ChatScreen({ runtime, sessionId, initialLines }: ChatScreenProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => initialLines.map((text) => ({ id: nextLineId(), text })));
  const [streamingText, setStreamingText] = useState("");
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const pushLine = useCallback((text: string) => {
    setLines((prev) => [...prev, { id: nextLineId(), text }]);
  }, []);

  const runTurn = useCallback(async (userText: string) => {
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
  }, [runtime, sessionId, pushLine]);

  const onResolveApproval = useCallback((approved: boolean) => {
    if (!pending) return;
    runtime.resolveApproval(pending.call.id, approved);
    setPending(null);
  }, [pending, runtime]);

  const onSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    setInput("");
    if (!trimmed || busy) return;
    void runTurn(trimmed);
  }, [busy, runTurn]);

  useInput((_input, key) => {
    if (key.escape && !pending) exit();
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => <Text key={line.id}>{line.text}</Text>}
      </Static>
      {streamingText ? <Text>{streamingText}</Text> : null}
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box>
          <Text color="green">{"> "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} focus={!busy} />
        </Box>
      )}
    </Box>
  );
}
