import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Banner } from "./Banner";
import { Spinner } from "./Spinner";
import { useTheme } from "./theme";

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
  { name: "/theme", description: "toggle light/dark theme" },
  { name: "/exit", description: "exit zero" },
  { name: "/quit", description: "exit zero (alias for /exit)" },
];

function matchingCommands(value: string) {
  return value.startsWith("/") ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value)) : [];
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeArgs(args: unknown): string {
  try {
    return truncate(JSON.stringify(args), 60);
  } catch {
    return "";
  }
}

// Banner is fixed content (11 logo rows + 2 border rows + version/cwd line
// + subtitle line + marginBottom), so its rendered height is a known
// constant rather than something to measure - deliberately avoiding a
// measure-after-render (e.g. Ink's measureElement + useLayoutEffect) round
// trip, which needs a second render pass with a different computed height
// than the first and was empirically unreliable here.
const HEADER_HEIGHT = 16;

export function ChatScreen({ runtime, sessionId, initialLines, cwd, version, onFirstMessage }: ChatScreenProps) {
  const { exit } = useApp();
  const { theme, toggle: toggleTheme } = useTheme();
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [lines, setLines] = useState<Line[]>(() => initialLines.map((text) => ({ id: nextLineId(), text })));
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const hasSentRef = useRef(false);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows || 24);
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const pushLine = useCallback((text: string, style?: { dim?: boolean; bold?: boolean; color?: string }) => {
    setLines((prev) => [...prev, { id: nextLineId(), text, ...style }]);
  }, []);

  const runTurn = useCallback(async (userText: string) => {
    if (!hasSentRef.current) {
      hasSentRef.current = true;
      onFirstMessage?.(userText);
    }
    setBusy(true);
    setStatus("Thinking");
    // Blank line before every turn gives visible breathing room between
    // one exchange and the next in the transcript.
    pushLine("");
    pushLine(`> ${userText}`, { color: theme.userColor, bold: true });
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
          setStatus(`Running ${event.call.name}`);
        } else if (event.type === "approvalRequest") {
          setPending({ call: event.call, preview: event.preview });
          setStatus(null);
        } else if (event.type === "toolResult") {
          // Collapsed into a single dim summary line - the live "Running
          // <tool>" status above already covered the in-flight state, so
          // the transcript itself never shows the raw call + raw result
          // as two separate noisy lines.
          pushLine(
            `✓ ${event.call.name} ${summarizeArgs(event.call.args)} → ${truncate(event.result, 60)}`,
            { color: theme.toolLine, dim: true },
          );
          setStatus("Thinking");
        } else if (event.type === "error") {
          pushLine(`[error] ${event.message}`, { color: "red" });
        } else if (event.type === "done") {
          if (assistantText) pushLine(assistantText, { color: theme.assistantColor });
        }
      }
    } finally {
      setStreamingText("");
      setStatus(null);
      setBusy(false);
      controllerRef.current = null;
    }
  }, [runtime, sessionId, pushLine, onFirstMessage, theme.userColor, theme.toolLine, theme.assistantColor]);

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
    if (trimmed === "/theme") {
      toggleTheme();
      return;
    }
    void runTurn(trimmed);
  }, [busy, runTurn, exit, pushLine, toggleTheme]);

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

  // Footer height is computed synchronously from state rather than
  // measured after render, for the same reason as HEADER_HEIGHT above:
  // border box (3 rows: top/content/bottom) plus either the hint line (1),
  // the autocomplete list (one row per suggestion), or nothing (the
  // approval prompt's own fixed-size box replaces the input entirely).
  const footerHeight = pending ? 6 : 3 + (suggestions.length > 0 ? suggestions.length : 1);

  // Total height is pinned strictly below the terminal's row count: Ink
  // fully clears and rewrites the whole screen (the cause of both the
  // flicker and the header/transcript scrolling out of view) whenever the
  // live region's computed height reaches stdout.rows. Reserving one row
  // keeps every render under that threshold.
  const totalHeight = Math.max(3, rows - 1);
  const liveExtra = (busy && status ? 1 : 0) + (streamingText ? 1 : 0);
  const middleHeight = Math.max(0, totalHeight - HEADER_HEIGHT - footerHeight - liveExtra);
  const visibleLines = lines.slice(-middleHeight);

  return (
    <Box flexDirection="column" height={totalHeight} overflow="hidden">
      <Banner cwd={cwd} version={version} subtitle="/exit to quit · esc cancels a turn · / for commands" />
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {visibleLines.map((line) => (
          <Text key={line.id} color={line.color} bold={line.bold} dimColor={line.dim}>
            {line.text || " "}
          </Text>
        ))}
        {busy && status ? <Spinner label={status} /> : null}
        {streamingText ? <Text color={theme.assistantColor}>{streamingText}</Text> : null}
      </Box>
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box flexDirection="column">
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Text color={theme.accent}>{"> "}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} focus={!busy} />
          </Box>
          {suggestions.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {suggestions.map((c, i) => (
                <Text key={c.name} color={i === activeSuggestion ? theme.accent : undefined} dimColor={i !== activeSuggestion}>
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
