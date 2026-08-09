import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Banner } from "./Banner";
import { MessageBlock } from "./MessageBlock";
import { Spinner } from "./Spinner";
import { useTheme } from "./theme";
import { estimateTextRows, parseBlocks } from "./markdown";

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
interface Line { id: string; text: string; bold?: boolean; dim?: boolean; color?: string; spacer?: boolean }

// How many lines a PageUp/PageDown scroll step moves. Deliberately in
// "lines" rather than "rows" - keeps the step size stable regardless of
// how much of the visible content happens to be wrapped that render.
const SCROLL_PAGE_LINES = 8;

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
  const [columns, setColumns] = useState(stdout.columns || 80);
  // Resumed transcript lines carry no structured role - App.tsx's
  // linesFromMessages() prefixes user turns with "> " (the same
  // convention runTurn below uses live), so that prefix is what
  // distinguishes them here. Without this, every resumed line rendered in
  // the same default color, making it impossible to tell who said what.
  const [lines, setLines] = useState<Line[]>(() => initialLines.map((text, i) => {
    const isUser = text.startsWith("> ");
    return {
      id: nextLineId(),
      text,
      color: isUser ? theme.userColor : theme.assistantColor,
      bold: isUser,
      spacer: isUser && i > 0,
    };
  }));
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  // Number of newest *lines* (not rows) currently scrolled out of view
  // below the visible window. 0 means pinned to the live tail.
  const [scrollOffset, setScrollOffset] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const hasSentRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      setRows(stdout.rows || 24);
      setColumns(stdout.columns || 80);
    };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  const pushLine = useCallback((text: string, style?: { dim?: boolean; bold?: boolean; color?: string; spacer?: boolean }) => {
    setLines((prev) => [...prev, { id: nextLineId(), text, ...style }]);
  }, []);

  const runTurn = useCallback(async (userText: string) => {
    if (!hasSentRef.current) {
      hasSentRef.current = true;
      onFirstMessage?.(userText);
    }
    setBusy(true);
    setStatus("Thinking");
    // "spacer" reserves a fixed one-row gap above this line as part of
    // the same entry (rather than a separate blank Line) so the tail
    // slicing and scroll offset below can never split a message from
    // its own leading gap - which is what made the spacing look
    // inconsistent once the transcript needed trimming or scrolling.
    pushLine(`> ${userText}`, { color: theme.userColor, bold: true, spacer: true });
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
    // Sending a message is the user opting back into "live" view - jump
    // back to the tail even if they'd scrolled up to reread history.
    setScrollOffset(0);
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
    if (!pending) {
      // Many Mac keyboards have no dedicated Page Up/Down keys, so Ctrl+U
      // / Ctrl+D (the vim/less convention for half-page scroll) are the
      // primary bindings; PageUp/PageDown still work for terminals/
      // keyboards that do send them (e.g. via fn+Up/Down).
      const scrollUp = key.pageUp || (key.ctrl && _input === "u");
      const scrollDown = key.pageDown || (key.ctrl && _input === "d");
      if (scrollUp) { setScrollOffset((o) => Math.min(Math.max(0, lines.length - 1), o + SCROLL_PAGE_LINES)); return; }
      if (scrollDown) { setScrollOffset((o) => Math.max(0, o - SCROLL_PAGE_LINES)); return; }
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
  // Ink wraps Text content at the terminal width by default, and embedded
  // "\n"s (multi-line replies, fenced code blocks) each force their own
  // row, so a single pushed "line" can occupy several actual terminal
  // rows. Slicing by array-index count alone under-counts that, letting
  // the real rendered height creep past totalHeight until it reaches
  // stdout.rows again - re-triggering Ink's full-clear-and-rewrite (this
  // file's original bug) after enough long/multi-line messages
  // accumulate. estimateTextRows (shared with MessageBlock's own
  // rendering, so the two stay in sync) accounts for both. Walk from the
  // newest line backward so the slice always fits the space available.
  const rowsForText = (text: string) => estimateTextRows(text, columns);
  const lineRowCost = (line: Line) => rowsForText(line.text) + (line.spacer ? 1 : 0);
  const streamingRows = streamingText ? rowsForText(streamingText) : 0;
  const liveExtra = (busy && status ? 1 : 0) + streamingRows;
  // Conversations can run longer than the terminal - rather than only
  // ever showing the live tail, PageUp/PageDown (see useInput above) walk
  // scrollOffset back through older lines. clampedOffset keeps that in
  // range as the transcript grows or shrinks (e.g. right after mount).
  const clampedOffset = Math.min(scrollOffset, Math.max(0, lines.length - 1));
  const isScrolled = clampedOffset > 0;
  // Reserve one row for the "scrolled up" indicator below so it never
  // itself pushes a transcript line out of the fixed-height box.
  const middleHeight = Math.max(0, totalHeight - HEADER_HEIGHT - footerHeight - liveExtra - (isScrolled ? 1 : 0));
  const bottomIndex = lines.length - 1 - clampedOffset;
  const visibleLines: Line[] = [];
  let usedRows = 0;
  for (let i = bottomIndex; i >= 0; i--) {
    const line = lines[i]!;
    const rowsNeeded = lineRowCost(line);
    if (usedRows + rowsNeeded > middleHeight) {
      // A single plain-text message longer than the whole budget (e.g.
      // one huge unbroken paragraph) would otherwise make the loop bail
      // before adding anything, leaving the transcript blank - so it's
      // still shown, letting overflow="hidden" clip the excess. A code
      // block clipped mid-box instead leaves a dangling open border with
      // no content or closing edge, which reads as broken rather than
      // "trimmed" - so code-block messages only ever render whole.
      const hasCodeBlock = parseBlocks(line.text).some((b) => b.kind === "code");
      if (hasCodeBlock || visibleLines.length > 0) break;
    }
    usedRows += rowsNeeded;
    visibleLines.unshift(line);
    if (usedRows >= middleHeight) break;
  }

  return (
    <Box flexDirection="column" height={totalHeight} overflow="hidden">
      <Banner cwd={cwd} version={version} subtitle="/exit to quit · esc cancels a turn · / for commands" />
      {/* overflow="hidden" only clips painting - Yoga still sizes a
          flexGrow box to fit its content unless height is pinned, which
          let long-wrapped transcript content balloon past totalHeight and
          squeeze the header/footer instead of being clipped. An explicit
          height plus flexShrink=0 makes this box (and its siblings below)
          immovable regardless of content length. */}
      <Box flexDirection="column" height={middleHeight + (isScrolled ? 1 : 0)} flexShrink={0} overflow="hidden">
        {isScrolled ? <Text dimColor>↑ scrolled up · Ctrl+D (or PageDown) to jump to latest</Text> : null}
        {visibleLines.map((line) => (
          <MessageBlock key={line.id} line={line} codeBorderColor={theme.toolLine} />
        ))}
        {!isScrolled && busy && status ? <Spinner label={status} /> : null}
        {!isScrolled && streamingText ? <Text color={theme.assistantColor}>{streamingText}</Text> : null}
      </Box>
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box flexDirection="column" flexShrink={0}>
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
