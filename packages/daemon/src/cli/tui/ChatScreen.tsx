import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { AgentRuntime, ChatToolCall } from "@zero/core";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { Banner } from "./Banner";
import { CodeBlockView, TextBlockView } from "./MessageBlock";
import { ModelPicker } from "./ModelPicker";
import { Spinner } from "./Spinner";
import { useTheme } from "./theme";
import { estimateBlockRows, estimateTextRows, parseBlocks, prepareMessageForTranscript } from "./markdown";

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
  models?: string[];
  activeModel?: string | null;
  onSelectModel?: (name: string) => void | Promise<void>;
}

interface PendingApproval { call: ChatToolCall; preview: string }
interface Line { id: string; text: string; bold?: boolean; dim?: boolean; color?: string; spacer?: boolean; timestamp?: string; markdown?: boolean }

// How many transcript entries (each entry being one block: a text
// paragraph, a whole code block, or the header) a scroll step moves.
// Deliberately in "entries" rather than "rows" - keeps the step size
// stable regardless of how much of the visible content happens to be
// wrapped that render.
const SCROLL_PAGE_ENTRIES = 8;

let lineSeq = 0;
function nextLineId(): string { return `line-${++lineSeq}`; }

const SLASH_COMMANDS = [
  { name: "/help", description: "list available commands" },
  { name: "/model", description: "switch model" },
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

/** Wall-clock `HH:MM:SS`, prefixed onto each live turn's user/assistant
 * lines below so a resumed-later reader can tell when things happened -
 * resumed-session lines (seeded via `initialLines`) predate this and are
 * left as-is rather than backfilled with a guessed time. */
function formatClock(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

export function ChatScreen({ runtime, sessionId, initialLines, cwd, version, onFirstMessage, models = [], activeModel = null, onSelectModel }: ChatScreenProps) {
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
  const [lines, setLines] = useState<Line[]>(() => initialLines.map((text) => {
    const isUser = text.startsWith("> ");
    return {
      id: nextLineId(),
      text,
      color: isUser ? theme.userColor : theme.assistantColor,
      bold: isUser,
      spacer: isUser,
    };
  }));
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  // Submitted messages, oldest first, for Up/Down history recall in the
  // input bar (shell-style). historyIndex of -1 means "not currently
  // recalling - show the live draft"; draftRef holds whatever the user
  // had typed before the first Up press, so Down can restore it. Seeded
  // from any resumed transcript's user turns (same "> " convention as
  // above) so history recall survives resuming a session, not just live
  // submissions in this process.
  const [history, setHistory] = useState<string[]>(() =>
    initialLines.filter((text) => text.startsWith("> ")).map((text) => text.slice(2)),
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draftRef = useRef("");
  // Number of newest *entries* (blocks, not rows - see `entries` below)
  // currently scrolled out of view below the visible window. 0 means
  // pinned to the live tail.
  const [scrollOffset, setScrollOffset] = useState(0);
  const [pickingModel, setPickingModel] = useState(false);
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

  const pushLine = useCallback((text: string, style?: { dim?: boolean; bold?: boolean; color?: string; spacer?: boolean; timestamp?: string; markdown?: boolean }) => {
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
    pushLine(`> ${userText}`, { color: theme.userColor, bold: true, spacer: true, timestamp: formatClock() });
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
          if (assistantText) {
            const { text, format } = prepareMessageForTranscript(assistantText);
            pushLine(text, { color: theme.assistantColor, timestamp: formatClock(), markdown: format === "markdown" });
          }
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
    setHistoryIndex(-1);
    draftRef.current = "";
    if (!trimmed || busy) return;
    setHistory((prev) => (prev[prev.length - 1] === trimmed ? prev : [...prev, trimmed]));
    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
    if (trimmed === "/help") {
      for (const c of SLASH_COMMANDS) pushLine(`${c.name}  ${c.description}`);
      return;
    }
    if (trimmed === "/theme") {
      toggleTheme();
      return;
    }
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      const arg = trimmed.slice("/model".length).trim();
      if (!arg) { setPickingModel(true); return; }
      void onSelectModel?.(arg);
      pushLine(`model: ${arg}`);
      return;
    }
    // Sending a message is the user opting back into "live" view - jump
    // back to the tail even if they'd scrolled up to reread history.
    setScrollOffset(0);
    void runTurn(trimmed);
  }, [busy, runTurn, exit, pushLine, toggleTheme, onSelectModel]);

  // The onChange TextInput calls for actual typed keystrokes. History
  // recall (below) sets `input` directly instead of through this, so
  // typing - which always comes through here - can reliably detect "the
  // user diverged from the recalled entry" and drop back to draft mode.
  const onTypedInputChange = useCallback((value: string) => {
    setHistoryIndex(-1);
    setInput(value);
  }, []);

  const suggestions = matchingCommands(input);
  const activeSuggestion = Math.min(suggestionIndex, Math.max(0, suggestions.length - 1));

  useInput((_input, key) => {
    if (pickingModel) return;
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
    if (!pending && suggestions.length === 0) {
      // Page Up/Down scroll the transcript (Fn+Up/Down on a Mac keyboard
      // without dedicated Page Up/Down keys). ink-text-input inserts any
      // key it doesn't special-case as literal text, but Page Up/Down are
      // "named" keys Ink itself resolves to an empty `input` string
      // (see parse-keypress's nonAlphanumericKeys), so ink-text-input's
      // own "insert this into the text" branch has nothing to insert -
      // safe by construction, not by luck.
      if (key.pageUp) { setScrollOffset((o) => Math.min(Math.max(0, entries.length - 1), o + SCROLL_PAGE_ENTRIES)); return; }
      if (key.pageDown) { setScrollOffset((o) => Math.max(0, o - SCROLL_PAGE_ENTRIES)); return; }
      // Up/Down cycle through previously submitted messages, shell-style.
      if (key.upArrow) {
        if (history.length === 0) return;
        if (historyIndex === -1) draftRef.current = input;
        const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        setInput(history[nextIndex]!);
        return;
      }
      if (key.downArrow) {
        if (historyIndex === -1) return;
        if (historyIndex >= history.length - 1) {
          setHistoryIndex(-1);
          setInput(draftRef.current);
        } else {
          const nextIndex = historyIndex + 1;
          setHistoryIndex(nextIndex);
          setInput(history[nextIndex]!);
        }
        return;
      }
    }
  });

  // Footer height is computed synchronously from state rather than
  // measured after render, for the same reason the transcript entries
  // below carry their own precomputed row costs: border box (3 rows:
  // top/content/bottom) plus either the hint line (1), the autocomplete
  // list (one row per suggestion), or nothing (the approval prompt's own
  // fixed-size box replaces the input entirely).
  const footerHeight = pending ? 6 : 3 + (suggestions.length > 0 ? suggestions.length : 1);

  // Total height is pinned strictly below the terminal's row count: Ink
  // fully clears and rewrites the whole screen (the cause of both the
  // flicker and the header/transcript scrolling out of view) whenever the
  // live region's computed height reaches stdout.rows. Reserving one row
  // keeps every render under that threshold.
  const totalHeight = Math.max(3, rows - 1);

  // The header is no longer pinned outside the scrollable area - it's the
  // oldest entry in the same list as every message, so it scrolls out of
  // view like any other old content and reappears when scrolling back to
  // the very top. Each *block* (not each message) is its own entry so a
  // reply with, say, two code blocks separated by prose can have one land
  // on the current page and the other on the next, instead of the whole
  // message being forced to appear atomically (which - given code blocks
  // must never render partially, see below - meant a message taller than
  // one full page could never be shown at all).
  const entries: Array<{ id: string; rows: number; atomic: boolean; render: () => React.ReactNode }> = [
    { id: "banner", rows: HEADER_HEIGHT, atomic: true, render: () => <Banner key="banner" cwd={cwd} version={version} subtitle={`${activeModel ?? "no model"} · /model to switch · /exit to quit`} /> },
  ];
  for (const line of lines) {
    const blocks = parseBlocks(line.text);
    blocks.forEach((block, i) => {
      const spacerHere = i === 0 && line.spacer;
      const timestampHere = i === 0 ? line.timestamp : undefined;
      const rows = estimateBlockRows(block, columns) + (spacerHere ? 1 : 0) + (timestampHere ? 1 : 0);
      const id = `${line.id}-b${i}`;
      if (block.kind === "code") {
        entries.push({
          id, rows, atomic: true,
          render: () => (
            <Box key={id} flexDirection="column" flexShrink={0} marginTop={spacerHere ? 1 : 0}>
              {timestampHere ? <Text dimColor>{timestampHere}</Text> : null}
              <CodeBlockView block={block} borderColor={theme.toolLine} />
            </Box>
          ),
        });
      } else {
        entries.push({
          id, rows, atomic: false,
          render: () => (
            <Box key={id} flexDirection="column" flexShrink={0} marginTop={spacerHere ? 1 : 0}>
              {timestampHere ? <Text dimColor>{timestampHere}</Text> : null}
              <TextBlockView content={block.content} line={line} />
            </Box>
          ),
        });
      }
    });
  }

  const streamingRows = streamingText ? estimateTextRows(streamingText, columns) : 0;
  const liveExtra = (busy && status ? 1 : 0) + streamingRows;
  // Conversations can run longer than the terminal - rather than only
  // ever showing the live tail, Page Up/Down (see useInput above) walk
  // scrollOffset back through older entries. clampedOffset keeps that in
  // range as entries grow or shrink (e.g. right after mount).
  const clampedOffset = Math.min(scrollOffset, Math.max(0, entries.length - 1));
  const isScrolled = clampedOffset > 0;
  // Reserve one row for the "scrolled up" indicator below so it never
  // itself pushes a transcript entry out of the fixed-height box.
  const scrollAreaHeight = Math.max(0, totalHeight - footerHeight - liveExtra - (isScrolled ? 1 : 0));
  const bottomIndex = entries.length - 1 - clampedOffset;
  const visibleEntries: typeof entries = [];
  let usedRows = 0;
  for (let i = bottomIndex; i >= 0; i--) {
    const entry = entries[i]!;
    if (usedRows + entry.rows > scrollAreaHeight) {
      // A single plain-text entry longer than the whole budget (e.g. one
      // huge unbroken paragraph) would otherwise make the loop bail
      // before adding anything, leaving the transcript blank - so it's
      // still shown, letting overflow="hidden" clip the excess. An atomic
      // entry (a code block, or the header banner) clipped mid-box
      // instead leaves a dangling open border with no content or closing
      // edge, which reads as broken rather than "trimmed" - so those only
      // ever render whole, on whichever page has room for them.
      if (entry.atomic || visibleEntries.length > 0) break;
    }
    usedRows += entry.rows;
    visibleEntries.unshift(entry);
    if (usedRows >= scrollAreaHeight) break;
  }

  if (pickingModel) {
    return (
      <ModelPicker
        models={models}
        active={activeModel}
        cwd={cwd}
        version={version}
        onCancel={() => setPickingModel(false)}
        onSelect={(name) => {
          setPickingModel(false);
          void onSelectModel?.(name);
          pushLine(`model: ${name}`);
        }}
      />
    );
  }

  return (
    <Box flexDirection="column" height={totalHeight} overflow="hidden">
      {/* overflow="hidden" only clips painting - Yoga still sizes a
          flexGrow box to fit its content unless height is pinned, which
          let long-wrapped transcript content balloon past totalHeight and
          squeeze the footer instead of being clipped. An explicit height
          plus flexShrink=0 makes this box (and its siblings below)
          immovable regardless of content length. */}
      <Box flexDirection="column" height={scrollAreaHeight + (isScrolled ? 1 : 0)} flexShrink={0} overflow="hidden">
        {isScrolled ? <Text dimColor>↑ scrolled up · PageDown to return to latest</Text> : null}
        {visibleEntries.map((entry) => entry.render())}
        {!isScrolled && busy && status ? <Spinner label={status} /> : null}
        {!isScrolled && streamingText ? <Text color={theme.assistantColor}>{streamingText}</Text> : null}
      </Box>
      {pending ? (
        <ApprovalPrompt call={pending.call} preview={pending.preview} onResolve={onResolveApproval} />
      ) : (
        <Box flexDirection="column" flexShrink={0}>
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
            <Text color={theme.accent}>{"> "}</Text>
            <TextInput value={input} onChange={onTypedInputChange} onSubmit={onSubmit} focus={!busy} />
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
            <Text dimColor>{busy ? "working..." : `${activeModel ?? "no model"} · /model to switch · / for commands`}</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
