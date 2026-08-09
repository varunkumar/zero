// packages/daemon/src/cli/tui/App.tsx
import React, { useEffect, useState } from "react";
import { Text, useApp } from "ink";
import type { AgentRuntime } from "@zero/core";
import type { ChatMessage, ChatSessionSummary } from "@zero/protocol";
import type { SessionStore } from "../../sessions";
import { SessionPicker } from "./SessionPicker";
import { ChatScreen } from "./ChatScreen";
import { Banner } from "./Banner";

export type StartMode = { kind: "new" } | { kind: "resume" } | { kind: "session"; sessionId: string };

export interface AppProps {
  sessions: SessionStore;
  start: StartMode;
  newSessionTitle: string;
  createRuntime: (sessionId: string) => AgentRuntime;
  cwd: string;
}

type ViewState =
  | { kind: "loading" }
  | { kind: "picker"; items: ChatSessionSummary[] }
  | { kind: "chat"; sessionId: string; runtime: AgentRuntime; initialLines: string[] }
  | { kind: "error"; message: string };

function linesFromMessages(messages: ChatMessage[]): string[] {
  return messages
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.length > 0))
    .map((m) => (m.role === "user" ? `> ${m.content}` : m.content));
}

export function App({ sessions, start, newSessionTitle, createRuntime, cwd }: AppProps) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const { exit } = useApp();

  // Resuming an unknown/deleted session id (or a fresh-session lookup
  // racing a delete) lands here; without this, Ink never terminates on its
  // own and the process hangs until the user hits Ctrl+C. Known gap: this
  // only stops the hang, it doesn't propagate a non-zero exit code out of
  // <App> (runTui.tsx still reports 0) - that needs return-value plumbing
  // out of the component and is out of scope here.
  useEffect(() => {
    if (state.kind === "error") exit();
  }, [state.kind, exit]);

  useEffect(() => {
    let cancelled = false;

    async function enterChat(sessionId: string) {
      const existing = await sessions.get(sessionId);
      if (!existing) {
        if (!cancelled) setState({ kind: "error", message: `session not found: ${sessionId}` });
        return;
      }
      if (!cancelled) {
        setState({
          kind: "chat", sessionId,
          runtime: createRuntime(sessionId),
          initialLines: linesFromMessages(existing.messages),
        });
      }
    }

    async function bootstrap() {
      if (start.kind === "resume") {
        const items = await sessions.list();
        if (!cancelled) setState({ kind: "picker", items });
        return;
      }
      const sessionId = start.kind === "session" ? start.sessionId : await sessions.create(newSessionTitle);
      await enterChat(sessionId);
    }

    void bootstrap();
    return () => { cancelled = true; };
  }, [sessions, start, newSessionTitle, createRuntime]);

  const onPick = async (sessionId: string | "new") => {
    const id = sessionId === "new" ? await sessions.create(newSessionTitle) : sessionId;
    const existing = await sessions.get(id);
    if (!existing) { setState({ kind: "error", message: `session not found: ${id}` }); return; }
    setState({
      kind: "chat", sessionId: id,
      runtime: createRuntime(id),
      initialLines: linesFromMessages(existing.messages),
    });
  };

  if (state.kind === "loading") {
    return (
      <>
        <Banner cwd={cwd} />
        <Text dimColor>loading...</Text>
      </>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <Banner cwd={cwd} />
        <Text color="red">error: {state.message}</Text>
      </>
    );
  }
  if (state.kind === "picker") {
    return <SessionPicker cwd={cwd} sessions={state.items} onSelect={(id) => void onPick(id)} />;
  }
  // A session with no prior messages - either a freshly-created "new"
  // session or a resumed session that happens to be empty - still has its
  // generic default title. Rename it from the user's first submitted
  // message so `zero --resume`'s picker shows something distinguishable
  // instead of a wall of identical "New chat" rows.
  const onFirstMessage = state.initialLines.length === 0
    ? (text: string) => { void sessions.rename(state.sessionId, text.slice(0, 40)); }
    : undefined;
  return (
    <ChatScreen
      runtime={state.runtime}
      sessionId={state.sessionId}
      initialLines={state.initialLines}
      cwd={cwd}
      onFirstMessage={onFirstMessage}
    />
  );
}
