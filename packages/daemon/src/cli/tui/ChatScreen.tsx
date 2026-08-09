import React, { useCallback, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { bannerLines } from "./Banner";
import { Spinner } from "./Spinner";

export interface ChatScreenProps {
  runtime: Pick<AgentRuntime, "sendMessage" | "resolveApproval">;
  sessionId: string;
  initialLines: string[];
  cwd: string;
  version: string;
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

const SLASH_COMMANDS = [
  { name: "/help", description: "list available commands" },
  { name: "/exit", description: "exit zero" },
  { name: "/quit", description: "exit zero (alias for /exit)" },
];

function matchingCommands(value: string) {
  return value.startsWith("/") ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value)) : [];
}

export function ChatScreen({ runtime, sessionId, initialLines, cwd, version, onFirstMessage }: ChatScreenProps) {
  const { exit } = useApp();
  const [lines, setLines] = useState<Line[]>(() => [
    ...bannerLines(cwd, version, "/exit to quit · esc cancels a turn").map((l) => ({ id: nextLineId(), ...l })),
    ...initialLines.map((text) => ({ id: nextLineId(), text })),
  ]);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
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
    setStatus("Thinking");
    pushLine(`> ${userText}`);
    const controller = new AbortController();
    controllerRef.current = controller;
    let assistantText = "";
    try {
      for await (const event of runtime.sendMessage(sessionId, userText, controller.signal)) {
        if (event.type === "text") {
          assistantText += event.delta;
          setStreamingText(assistantText);
          setStatus(null);
        } else if (event.type === "toolCall") {
          pushLine(`[tool] ${event.call.name} ${JSON.stringify(event.call.args)}`);
          setStatus(`Running ${event.call.name}`);
        } else if (event.type === "approvalRequest") {
          setPending({ call: event.call, preview: event.preview });
          setStatus(null);
        } else if (event.type === "toolResult") {
          pushLine(`[result] ${event.result}`);
          setStatus("Thinking");
        } else if (event.type === "error") {
          pushLine(`[error] ${event.message}`);
        } else if (event.type === "done") {
          if (assistantText) pushLine(assistantText);
        }
      }
    } finally {
      setStreamingText("");
      setStatus(null);
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
    setSuggestionIndex(0);
    if (!trimmed || busy) return;
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/help") {
      for (const c of SLASH_COMMANDS) pushLine(`${c.name}  ${c.description}`);
      return;
    }
    void runTurn(trimmed);
  }, [busy, runTurn, exit, pushLine]);

  const suggestions = matchingCommands(input);
  const activeSuggestion = Math.min(suggestionIndex, Math.max(0, suggestions.length - 1));

  useInput((_input, key) => {
    if (key.escape) {
      if (!pending && suggestions.length > 0) setInput("");
      else if (!pending) exit();
      return;
    }
    if (!pending && suggestions.length > 0) {
      if (key.downArrow) { setSuggestionIndex((i) => Math.min(suggestions.length - 1, i + 1)); return; }
      if (key.upArrow) { setSuggestionIndex((i) => Math.max(0, i - 1)); return; }
      if (key.tab) { setInput(`${suggestions[activeSuggestion]!.name} `); setSuggestionIndex(0); return; }
    }
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
      {busy && status ? <Spinner label={status} /> : null}
      {streamingText ? <Text>{streamingText}</Text> : null}
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor="gray" paddingX={1}>
            <Text color="green">{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} focus={!busy} />
          </Box>
          {suggestions.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {suggestions.map((c, i) => (
                <Text key={c.name} color={i === activeSuggestion ? "cyan" : undefined} dimColor={i !== activeSuggestion}>
                  {i === activeSuggestion ? "> " : "  "}{c.name}  {c.description}
                </Text>
              ))}
            </Box>
          ) : (
            <Text dimColor>{busy ? "working..." : "/exit to quit · / for commands"}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
